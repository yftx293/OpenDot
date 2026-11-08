// Product HTTP + actual service owner process + official Harness/SQLite.
// The local OpenAI-compatible HTTP provider is deterministic, not a real model.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Product runtime assertion timed out');
}
test('formal product admission resumes the original Durable submission after killing its actual service owner (HTTP provider simulated)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-durable-http-'));
  const repository = process.cwd();
  let webPort = 0,
    origin = '';
  let child: ChildProcess | undefined;
  let cookie = '';
  let hold = true;
  let providerMode: 'read' | 'artifact' | 'goal' | 'loop' = 'read';
  let readPath = 'fixture.txt';
  const requests: { messages: { role: string; content?: unknown }[] }[] = [];
  const held = new Set<ServerResponse>();
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as (typeof requests)[number];
    requests.push(body);
    if (hold) {
      held.add(response);
      response.once('close', () => held.delete(response));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let lastUser = -1;
    for (let index = body.messages.length - 1; index >= 0; index--)
      if (body.messages[index].role === 'user') {
        lastUser = index;
        break;
      }
    const toolCount = body.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === 'tool').length;
    const toolResult = toolCount > 0;
    const goalArtifact = providerMode === 'goal' && toolCount === 1;
    const delta =
      toolResult && !goalArtifact && providerMode !== 'loop'
        ? { role: 'assistant', content: 'PRODUCT_DURABLE_FIXTURE_DONE' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'workspace-read-1',
                type: 'function',
                function: {
                  name:
                    providerMode === 'artifact' || goalArtifact
                      ? 'create_approved_artifact'
                      : 'read_workspace_file',
                  arguments: JSON.stringify(
                    providerMode === 'artifact' || goalArtifact
                      ? {
                          content: goalArtifact
                            ? 'GOAL_FILE_EVIDENCE:AUTHORIZED_WORKSPACE_FILE_EVIDENCE'
                            : 'APPROVED_ARTIFACT_FIXTURE',
                        }
                      : { path: readPath },
                  ),
                },
              },
            ],
          };
    const packet = (value: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    response.end(
      packet(delta, null) +
        packet({}, 'tool_calls' in delta ? 'tool_calls' : 'stop') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerPort = (provider.address() as net.AddressInfo).port;
  async function request(
    url: string,
    method = 'GET',
    body?: unknown,
    key?: string,
  ) {
    const response = await fetch(origin + url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
      response,
    };
  }
  async function start(enabled: boolean) {
    let listening = false;
    const began = Date.now();
    child = spawn(
      process.execPath,
      [
        '--import',
        path.join(repository, 'tests/helpers/announce-listening.mjs'),
        path.join(repository, 'dist/index.js'),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, 'home'),
          WEB_PORT: String(webPort),
          TZ: 'Asia/Taipei',
          MINICLAW_DURABLE_RUNTIME: String(enabled),
          MINICLAW_PERSONAL_GOALS: 'true',
          PLUGIN_AUTO_SCAN: 'false',
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    child.on('message', (raw: unknown) => {
      const value = raw as {
        type?: string;
        pid?: number;
        root?: string;
        port?: number;
      };
      if (
        value.type !== 'miniclaw_fixture_listening_v1' ||
        value.pid !== child?.pid ||
        value.root !== root ||
        !Number.isInteger(value.port) ||
        value.port! <= 0 ||
        value.port! > 65535 ||
        (webPort !== 0 && value.port !== webPort)
      )
        return;
      webPort = value.port!;
      origin = `http://127.0.0.1:${webPort}`;
      listening = true;
    });
    await waitFor(async () => {
      if (child?.exitCode !== null && child?.exitCode !== undefined)
        throw new Error(`Product server exited: ${child.exitCode}`);
      if (!listening) return false;
      try {
        return (await request('/api/health')).status === 200;
      } catch {
        return false;
      }
    }, 120000);
    if (process.env.MINICLAW_FIXTURE_TIMING === '1')
      console.info(
        JSON.stringify({
          phase: 'product-backend-ready',
          milliseconds: Date.now() - began,
        }),
      );
  }
  async function stop(signal: NodeJS.Signals) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = child;
    const closed = once(stopped, 'close');
    stopped.kill(signal);
    const timer = setTimeout(() => stopped.kill('SIGKILL'), 10_000);
    const receipt = await closed;
    clearTimeout(timer);
    child = undefined;
    return receipt;
  }
  try {
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default-groups.json'), '[]');
    // Runtime tools resolve from the isolated fixture's working directory.
    fs.symlinkSync(
      path.join(repository, 'node_modules'),
      path.join(root, 'node_modules'),
      'dir',
    );
    fs.symlinkSync(
      path.join(repository, 'container'),
      path.join(root, 'container'),
      'dir',
    );
    await start(true);
    const setup = await request('/api/auth/setup', 'POST', {
      username: 'durable_fixture',
      password: `Fixture9!${randomBytes(24).toString('hex')}`,
    });
    expect(setup.status).toBe(201);
    cookie = setup.response.headers.get('set-cookie')!.split(';')[0];
    const configured = await request('/api/config/claude/providers', 'POST', {
      name: 'Local simulated HTTP provider',
      type: 'third_party',
      anthropicBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
      anthropicApiKey: 'fixture-test-token',
      anthropicModel: 'fixture-model',
      customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
    });
    expect(configured.status).toBe(201);
    const groups = (await request('/api/groups')).body.groups as Record<
      string,
      { folder: string }
    >;
    const jid = Object.keys(groups).find((value) => value.startsWith('web:'))!;
    const createRequestId = randomUUID();
    const created = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Durable product acceptance', requestId: createRequestId },
    );
    expect(created.status).toBe(200);
    const id = created.body.session.id as string;
    expect(created.body.session.runtime_kind).toBe('pi-durable');
    const other = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Independent recovery' },
    );
    expect(other.status).toBe(200);
    const otherId = other.body.session.id as string;
    const timed = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Duration budget' },
    );
    expect(timed.status).toBe(200);
    const timedId = timed.body.session.id as string;
    const skew = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Terminal checkpoint skew' },
    );
    expect(skew.status).toBe(200);
    const skewId = skew.body.session.id as string;
    const unsafeRead = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Unsafe file read guard' },
    );
    expect(unsafeRead.status).toBe(200);
    const unsafeId = unsafeRead.body.session.id as string;
    const abortSession = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Bound abort receipt' },
    );
    const abortId = abortSession.body.session.id as string;
    const abortScope = `/api/groups/${encodeURIComponent(jid)}/sessions/${abortId}`;
    expect(abortSession.body.session.runtime_kind).toBe('pi-durable');
    const approvalSession = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Approval restart' },
    );
    expect(approvalSession.status).toBe(200);
    expect(approvalSession.body.session.runtime_kind).toBe('pi-durable');
    const approvalSessionId = approvalSession.body.session.id;
    const approvalScope = `/api/groups/${encodeURIComponent(jid)}/sessions/${approvalSessionId}`;
    const duplicateCreation = await request(
      `/api/groups/${encodeURIComponent(jid)}/sessions`,
      'POST',
      { name: 'Durable product acceptance', requestId: createRequestId },
    );
    expect(duplicateCreation.status).toBe(200);
    expect(duplicateCreation.body.session.id).toBe(id);
    expect(
      (
        await request(
          `/api/groups/${encodeURIComponent(jid)}/sessions`,
          'POST',
          { name: 'Changed creation', requestId: createRequestId },
        )
      ).status,
    ).toBe(409);
    fs.mkdirSync(path.join(root, 'data/groups', groups[jid].folder), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'data/groups', groups[jid].folder, 'fixture.txt'),
      'AUTHORIZED_WORKSPACE_FILE_EVIDENCE',
    );
    const input = {
      chatJid: jid,
      agentId: id,
      requestId: randomUUID(),
      content: 'Read fixture.txt and report.',
      followUpBehavior: 'queue',
    };
    const admitted = await request('/api/messages', 'POST', input);
    expect(admitted.status).toBe(200);
    expect(admitted.body.runtime).toBe('pi-durable');
    await waitFor(() => requests.length === 1);
    const snapshotUrl = `/api/groups/${encodeURIComponent(jid)}/sessions/${id}/runtime`;
    const before = await request(snapshotUrl);
    expect(before.status).toBe(200);
    expect(before.body.inputs).toHaveLength(1);
    expect(before.body.live.busy).toBe(true);
    expect(before.body.live.queue).toEqual([]);
    expect(before.body.epoch).toEqual(expect.any(String));
    expect(before.body.revision).toBeGreaterThan(0);
    const submissionId = before.body.inputs[0].submission_id as number;
    const conversationId = before.body.runtime.conversation_id;
    const queued = [] as number[];
    const queuedBodies: Record<string, unknown>[] = [];
    for (const content of [
      'QUEUE_EDIT_ORIGINAL',
      'QUEUE_CANCELLED_CONTENT',
      'QUEUE_REORDERED_CONTENT',
    ]) {
      const queuedBody = { ...input, requestId: randomUUID(), content };
      queuedBodies.push(queuedBody);
      const result = await request('/api/messages', 'POST', queuedBody);
      expect(result.status).toBe(200);
      expect(result.body.disposition).toBe('queued');
      queued.push(result.body.submissionId);
    }
    const controlsUrl = snapshotUrl.replace(/runtime$/, 'controls');
    const queueSnapshot = async () => (await request(snapshotUrl)).body;
    const control = async (command: unknown, requestId = randomUUID()) =>
      request(controlsUrl, 'POST', { requestId, command });
    const originalQueue = await queueSnapshot();
    expect(
      originalQueue.live.queue.map(
        (item: { submissionId: number }) => item.submissionId,
      ),
    ).toEqual(queued);
    const editCommand = {
      action: 'edit',
      submissionId: queued[0],
      content: 'QUEUE_EDITED_CONTENT',
      expectedQueueDigest: originalQueue.live.queueDigest,
    };
    const editKey = randomUUID();
    const edited = await control(editCommand, editKey);
    expect(edited.status).toBe(200);
    expect(edited.body.control.state).toBe('applied');
    expect((await control(editCommand, editKey)).body.control.id).toBe(
      edited.body.control.id,
    );
    expect(
      (await control({ ...editCommand, content: 'DIFFERENT_EDIT' }, editKey))
        .status,
    ).toBe(409);
    expect(
      (
        await control({
          action: 'cancel',
          submissionId: queued[1],
          expectedQueueDigest: originalQueue.live.queueDigest,
        })
      ).body.control.state,
    ).toBe('rejected');
    const afterEdit = await queueSnapshot();
    expect(afterEdit.live.queue[0].content).toBe('QUEUE_EDITED_CONTENT');
    const retriedOriginal = await request(
      '/api/messages',
      'POST',
      queuedBodies[0],
    );
    expect(retriedOriginal.status).toBe(200);
    const historyProbe = new DatabaseSync(
      path.join(root, 'data/db/messages.db'),
    );
    try {
      expect(
        historyProbe
          .prepare('SELECT content FROM messages WHERE id=?')
          .get(retriedOriginal.body.messageId),
      ).toEqual({ content: 'QUEUE_EDITED_CONTENT' });
    } finally {
      historyProbe.close();
    }
    const concurrentDigest = (await queueSnapshot()).live.queueDigest;
    const concurrent = await Promise.all(
      ['QUEUE_CONCURRENT_A', 'QUEUE_CONCURRENT_B'].map((content) =>
        control({
          action: 'edit',
          submissionId: queued[2],
          content,
          expectedQueueDigest: concurrentDigest,
        }),
      ),
    );
    expect(
      concurrent.map((response) => response.body.control.state).sort(),
    ).toEqual(['applied', 'rejected']);

    expect(
      (
        await control({
          action: 'reorder',
          submissionIds: [queued[2], queued[0], queued[1]],
          expectedQueueDigest: (await queueSnapshot()).live.queueDigest,
        })
      ).body.control.state,
    ).toBe('applied');
    expect(
      (
        await control({
          action: 'steer',
          submissionId: queued[0],
          expectedQueueDigest: (await queueSnapshot()).live.queueDigest,
        })
      ).body.control.state,
    ).toBe('applied');
    expect(
      (
        await control({
          action: 'cancel',
          submissionId: queued[1],
          expectedQueueDigest: (await queueSnapshot()).live.queueDigest,
        })
      ).body.control.state,
    ).toBe('applied');
    const wrongWorkspace = await request(
      controlsUrl.replace(
        encodeURIComponent(jid),
        encodeURIComponent('web:not-this-workspace'),
      ),
      'POST',
      { requestId: randomUUID(), command: editCommand },
    );
    expect(wrongWorkspace.status).toBe(409);
    expect(
      (await control({ ...editCommand, execution: { runId: 'FORGED' } }))
        .status,
    ).toBe(409);
    const otherPassword = `Fixture9!${randomBytes(24).toString('hex')}`;
    const otherAdmin = await request('/api/admin/users', 'POST', {
      username: 'durable_other_admin',
      password: otherPassword,
      role: 'admin',
      must_change_password: false,
    });
    expect(otherAdmin.status).toBe(201);
    const otherLogin = await request('/api/auth/login', 'POST', {
      username: 'durable_other_admin',
      password: otherPassword,
    });
    expect(otherLogin.status).toBe(200);
    const ownerCookie = cookie;
    try {
      cookie = otherLogin.response.headers.get('set-cookie')!.split(';')[0];
      expect((await request(snapshotUrl)).status).toBe(404);
      const forbidden = await control(editCommand, randomUUID());
      expect(forbidden.status).toBe(409);
      expect(JSON.stringify(forbidden.body)).not.toContain(
        'QUEUE_EDITED_CONTENT',
      );
    } finally {
      cookie = ownerCookie;
    }
    const finalQueue = await queueSnapshot();
    expect(
      finalQueue.live.queue.map(
        (item: { submissionId: number }) => item.submissionId,
      ),
    ).toEqual([queued[2], queued[0]]);
    expect(finalQueue.live.queue[1].mode).toBe('steer');
    expect(await stop('SIGKILL')).toEqual([null, 'SIGKILL']);
    hold = false;
    await start(false); // The persisted kind, not this flag, owns recovery.
    await waitFor(async () =>
      (await request(snapshotUrl)).body.inputs?.every(
        (entry: { state: string }) =>
          ['completed', 'failed'].includes(entry.state),
      ),
    );
    const after = await request(snapshotUrl);
    expect(after.body.runtime.runtime_kind).toBe('pi-durable');
    expect(after.body.runtime.conversation_id).toBe(conversationId);
    expect(after.body.inputs).toHaveLength(4);
    expect(
      after.body.inputs.find(
        (entry: { submission_id: number }) => entry.submission_id === queued[1],
      ).state,
    ).toBe('failed');
    expect(after.body.live.queue).toEqual([]);
    expect(
      requests.some((entry) =>
        JSON.stringify(entry.messages).includes('QUEUE_EDITED_CONTENT'),
      ),
    ).toBe(true);
    expect(
      requests.some((entry) =>
        JSON.stringify(entry.messages).includes('QUEUE_EDIT_ORIGINAL'),
      ),
    ).toBe(false);
    expect(
      requests.some((entry) =>
        JSON.stringify(entry.messages).includes('QUEUE_CANCELLED_CONTENT'),
      ),
    ).toBe(false);
    expect((await control(editCommand, editKey)).body.control.id).toBe(
      edited.body.control.id,
    );
    expect(after.body.inputs[0].submission_id).toBe(submissionId);
    expect(after.body.epoch).not.toBe(before.body.epoch);
    expect(after.body.revision).toBeGreaterThan(before.body.revision);
    expect(after.body.live.busy).toBe(false);
    expect(after.body.costStatus).toBe('unpriced');
    const answerProbe = new DatabaseSync(
      path.join(root, 'data/db/messages.db'),
    );
    try {
      const results = answerProbe
        .prepare(
          'SELECT answer_entry_id,message_id FROM product_input_results WHERE session_id=?',
        )
        .all(id) as { answer_entry_id: number; message_id: string }[];
      expect(results).toHaveLength(3);
      expect(
        new Set(results.map((row) => row.answer_entry_id)).size,
      ).toBeLessThan(results.length);
      for (const row of results)
        expect(
          answerProbe
            .prepare('SELECT count(*) AS n FROM messages WHERE id=?')
            .get(row.message_id),
        ).toEqual({ n: 1 });
    } finally {
      answerProbe.close();
    }

    expect(
      (await request('/api/usage/stats')).body.summary.durableUsageCoverage,
    ).toBe('not-included');
    expect(
      requests.some((entry) =>
        entry.messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes(
              'AUTHORIZED_WORKSPACE_FILE_EVIDENCE',
            ),
        ),
      ),
    ).toBe(true);
    const duplicate = await request('/api/messages', 'POST', input);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.messageId).toBe(admitted.body.messageId);
    expect(
      (
        await request('/api/messages', 'POST', {
          ...input,
          followUpBehavior: 'steer',
        })
      ).status,
    ).toBe(409);
    hold = true;
    expect(
      (
        await request('/api/messages', 'POST', {
          ...input,
          agentId: abortId,
          requestId: randomUUID(),
          content: 'ABORT_ORIGINAL_RUN',
        })
      ).status,
    ).toBe(200);
    await waitFor(() => held.size === 1);
    const abortSnapshot = (await request(`${abortScope}/runtime`)).body;
    const abortCommand = {
      action: 'abort',
      taskId: abortSnapshot.live.taskId,
      expectedQueueDigest: abortSnapshot.live.queueDigest,
    };
    const abortKey = randomUUID();
    const aborted = await request(`${abortScope}/controls`, 'POST', {
      requestId: abortKey,
      command: abortCommand,
    });
    expect(aborted.status).toBe(200);
    expect(aborted.body.control.state).toBe('applied');
    await waitFor(async () =>
      (await request(`${abortScope}/runtime`)).body.inputs.every(
        (row: { state: string }) => row.state === 'failed',
      ),
    );
    expect(
      (
        await request('/api/messages', 'POST', {
          ...input,
          agentId: abortId,
          requestId: randomUUID(),
          content: 'NEXT_RUN_MUST_SURVIVE_OLD_ABORT_RETRY',
        })
      ).status,
    ).toBe(200);
    await waitFor(() => held.size === 1);
    const nextRun = (await request(`${abortScope}/runtime`)).body;
    expect(nextRun.live.taskId).not.toBe(abortCommand.taskId);
    expect(
      (
        await request(`${abortScope}/controls`, 'POST', {
          requestId: abortKey,
          command: abortCommand,
        })
      ).body.control.id,
    ).toBe(aborted.body.control.id);
    expect((await request(`${abortScope}/runtime`)).body.live.busy).toBe(true);
    expect(
      (
        await request(`${abortScope}/controls`, 'POST', {
          requestId: randomUUID(),
          command: abortCommand,
        })
      ).body.control.state,
    ).toBe('rejected');
    expect(
      (
        await request(`${abortScope}/controls`, 'POST', {
          requestId: randomUUID(),
          command: {
            ...abortCommand,
            taskId: nextRun.live.taskId,
            expectedQueueDigest: nextRun.live.queueDigest,
          },
        })
      ).body.control.state,
    ).toBe('applied');
    await waitFor(() => held.size === 0);
    hold = false;
    // The executor, approval endpoints and artifact effect are real. Only model
    // responses are simulated. Kill while waiting, then approve from two clients.
    providerMode = 'artifact';
    const approvalInput = await request('/api/messages', 'POST', {
      chatJid: jid,
      agentId: approvalSessionId,
      requestId: randomUUID(),
      content: 'Create the proposed private artifact after approval.',
      followUpBehavior: 'queue',
    });
    expect(approvalInput.status).toBe(200);
    await waitFor(async () => {
      const view = await request(`${approvalScope}/approvals`);
      expect(view.status).toBe(200);
      if (view.body.approvals?.[0]?.state === 'pending') return true;
      const snapshot = await request(`${approvalScope}/runtime`);
      if (
        snapshot.body.inputs?.[0]?.state === 'completed' ||
        snapshot.body.inputs?.[0]?.state === 'failed'
      )
        throw new Error('Approval input ended before consent');
      return false;
    });
    const originalApproval = (await request(`${approvalScope}/approvals`)).body
      .approvals[0];
    expect(originalApproval.content).toBe('APPROVED_ARTIFACT_FIXTURE');
    const privateDirectory = path.join(root, 'data/db/private-artifacts');
    expect(fs.existsSync(privateDirectory)).toBe(false);
    expect(await stop('SIGKILL')).toEqual([null, 'SIGKILL']);
    await start(false);
    expect(
      (await request(`${approvalScope}/approvals`)).body.approvals[0],
    ).toMatchObject({ id: originalApproval.id, state: 'pending' });
    expect(fs.existsSync(privateDirectory)).toBe(false);
    expect(
      (
        await request(
          `${approvalScope}/approvals/${originalApproval.id}`,
          'POST',
          {
            parametersDigest: 'changed',
            decision: 'approve',
            requestId: randomUUID(),
          },
        )
      ).status,
    ).toBe(409);
    const decisions = await Promise.all(
      [randomUUID(), randomUUID()].map((requestId) =>
        request(`${approvalScope}/approvals/${originalApproval.id}`, 'POST', {
          parametersDigest: originalApproval.parameters_digest,
          decision: 'approve',
          requestId,
        }),
      ),
    );
    expect(decisions.map((value) => value.status)).toEqual([200, 200]);
    await waitFor(
      async () =>
        (await request(`${approvalScope}/runtime`)).body.inputs?.[0]?.state ===
        'completed',
    );
    expect(
      (await request(`${approvalScope}/runtime`)).body.inputs[0].submission_id,
    ).toBe(approvalInput.body.submissionId);
    expect(fs.readdirSync(privateDirectory)).toEqual([
      `${originalApproval.id}.txt`,
    ]);
    expect(
      (await request(`${approvalScope}/artifacts/${originalApproval.id}`)).body
        .artifact.content,
    ).toBe('APPROVED_ARTIFACT_FIXTURE');
    expect(
      (
        await request(
          `${approvalScope}/approvals/${originalApproval.id}`,
          'POST',
          {
            parametersDigest: originalApproval.parameters_digest,
            decision: 'deny',
            requestId: randomUUID(),
          },
        )
      ).status,
    ).toBe(409);
    // A real Goal API call now provisions and dispatches through the existing
    // Scheduler. This still uses the same local simulated model HTTP service.
    await stop('SIGINT');
    await start(true);
    providerMode = 'goal';
    const goalKey = randomUUID();
    const goalPayload = {
      workspace_jid: jid,
      objective: 'Research fixture.txt and deliver the evidence',
      completion_criteria: [
        'artifact_contains:AUTHORIZED_WORKSPACE_FILE_EVIDENCE',
      ],
      budget_max_runs: 2,
    };
    const goalCreated = await request(
      '/api/goals',
      'POST',
      goalPayload,
      goalKey,
    );
    expect(goalCreated.status).toBe(201);
    expect(goalCreated.body.execution?.success).toBe(true);
    const goalId = goalCreated.body.goal.id as string;
    const goalUrl = `/api/goals/${goalId}`;
    await waitFor(async () => {
      const view = (await request(goalUrl)).body;
      if (view.executions?.[0]?.status === 'failed')
        throw new Error(`Goal dispatch failed: ${view.executions[0].error}`);
      return view.goal?.status === 'waiting_for_approval';
    });
    const goalBefore = (await request(goalUrl)).body;
    expect(goalBefore.tasks).toHaveLength(1);
    expect(goalBefore.executions).toHaveLength(1);
    expect(goalBefore.goal.budget_used_runs).toBe(1);
    const goalRunId = goalBefore.executions[0].id;
    const goalSessionId = goalBefore.session.id;
    const goalScope = `/api/groups/${encodeURIComponent(jid)}/sessions/${goalSessionId}`;
    const goalRuntimeBefore = (await request(`${goalScope}/runtime`)).body;
    const goalApproval = goalRuntimeBefore.approvals[0];
    expect(goalApproval).toMatchObject({
      goal_id: goalId,
      run_id: goalRunId,
      task_id: goalBefore.tasks[0].id,
      state: 'pending',
    });
    expect(
      goalBefore.executions[0].definition_snapshot.personal_goal.objective,
    ).toBe(goalPayload.objective);
    expect(
      (
        await request(goalUrl, 'PATCH', {
          expected_revision: goalBefore.goal.revision,
          status: 'completed',
        })
      ).status,
    ).toBe(409);
    const humanCreated = await request(
      '/api/goals',
      'POST',
      {
        workspace_jid: jid,
        objective: 'Prepare findings for my review',
        completion_criteria: ['The findings are useful to me'],
        budget_max_runs: 1,
      },
      randomUUID(),
    );
    expect(humanCreated.status).toBe(201);
    const humanUrl = `/api/goals/${humanCreated.body.goal.id}`;
    await waitFor(
      async () =>
        (await request(humanUrl)).body.goal?.status === 'waiting_for_approval',
    );
    const humanBefore = (await request(humanUrl)).body;
    const humanRunId = humanBefore.executions[0].id;
    const humanScope = `/api/groups/${encodeURIComponent(jid)}/sessions/${humanBefore.session.id}`;
    const humanApproval = (await request(`${humanScope}/approvals`)).body
      .approvals[0];
    // Exercise the model-step fence through actual HTTP requests. This provider
    // keeps asking for a read tool; one run must stop without an endless loop.
    providerMode = 'loop';
    const loopStart = requests.length;
    const looping = await request(
      '/api/goals',
      'POST',
      {
        workspace_jid: jid,
        objective: 'Exercise bounded model requests',
        completion_criteria: ['artifact_contains:never-produced'],
        budget_max_runs: 1,
      },
      randomUUID(),
    );
    expect(looping.status).toBe(201);
    await waitFor(
      async () =>
        (await request(`/api/goals/${looping.body.goal.id}`)).body.goal
          ?.status === 'failed',
    );
    expect(requests.length - loopStart).toBeLessThanOrEqual(12);
    expect(requests.length - loopStart).toBeGreaterThan(0);
    providerMode = 'goal';
    expect(await stop('SIGKILL')).toEqual([null, 'SIGKILL']);
    // Inject lease-clock expiry only in the disposable database so the normal
    // Scheduler takeover path runs immediately instead of waiting 60 seconds.
    const leaseClock = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      leaseClock
        .prepare('UPDATE task_runs SET lease_expires_at=? WHERE id IN (?,?)')
        .run(new Date(Date.now() - 1000).toISOString(), goalRunId, humanRunId);
    } finally {
      leaseClock.close();
    }
    await start(false);
    await waitFor(async () => {
      const value = (await request(goalUrl)).body;
      return (
        value.executions?.[0]?.attempt >= 2 &&
        value.goal?.status === 'waiting_for_approval'
      );
    });
    const resumedGoal = (await request(goalUrl)).body;
    expect(resumedGoal.executions).toHaveLength(1);
    expect(resumedGoal.executions[0].id).toBe(goalRunId);
    expect(resumedGoal.goal.budget_used_runs).toBe(1);
    const goalRuntimeAfter = (await request(`${goalScope}/runtime`)).body;
    expect(goalRuntimeAfter.runtime.conversation_id).toBe(
      goalRuntimeBefore.runtime.conversation_id,
    );
    expect(goalRuntimeAfter.inputs[0].submission_id).toBe(
      goalRuntimeBefore.inputs[0].submission_id,
    );
    expect(goalRuntimeAfter.approvals[0].id).toBe(goalApproval.id);
    // Pause/continue retains the same occurrence and consent instead of
    // cancelling it or charging a second run.
    expect(
      (
        await request(goalUrl, 'PATCH', {
          expected_revision: resumedGoal.goal.revision,
          status: 'paused',
        })
      ).status,
    ).toBe(200);
    await waitFor(
      async () =>
        (await request(goalUrl)).body.executions?.[0]?.status === 'retry_wait',
    );
    const paused = (await request(goalUrl)).body;
    expect(
      (
        await request(`${goalScope}/approvals/${goalApproval.id}`, 'POST', {
          parametersDigest: goalApproval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(goalUrl, 'PATCH', {
          expected_revision: paused.goal.revision,
          status: 'pending',
        })
      ).status,
    ).toBe(200);
    await waitFor(
      async () =>
        (await request(goalUrl)).body.goal?.status === 'waiting_for_approval',
    );
    expect(
      (
        await request(`${goalScope}/approvals/${goalApproval.id}`, 'POST', {
          parametersDigest: goalApproval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);
    await waitFor(
      async () => (await request(goalUrl)).body.goal?.status === 'completed',
    );
    const completedGoal = (await request(goalUrl)).body;
    expect(completedGoal.executions).toHaveLength(1);
    expect(completedGoal.goal.budget_used_runs).toBe(1);
    expect(completedGoal.evidence[0].evidence).toEqual([
      {
        artifact_id: goalApproval.id,
        content_digest: goalApproval.content_digest,
        criteria_matches: [true],
      },
    ]);
    await waitFor(
      async () =>
        (await request(goalUrl)).body.executions?.[0]?.notification_status ===
        'success',
    );
    const duplicateGoal = await request(
      '/api/goals',
      'POST',
      goalPayload,
      goalKey,
    );
    expect(duplicateGoal.status).toBe(201);
    expect(duplicateGoal.body.goal.id).toBe(goalId);
    expect((await request(goalUrl)).body.executions).toHaveLength(1);
    expect(
      (
        await request(`${humanScope}/approvals/${humanApproval.id}`, 'POST', {
          parametersDigest: humanApproval.parameters_digest,
          decision: 'approve',
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);
    await waitFor(
      async () =>
        (await request(humanUrl)).body.goal?.status === 'waiting_for_input',
    );
    const humanResult = (await request(humanUrl)).body;
    expect(humanResult.evidence[0].evidence).toHaveLength(1);
    expect(
      (
        await request(humanUrl, 'PATCH', {
          expected_revision: humanResult.goal.revision,
          status: 'completed',
        })
      ).status,
    ).toBe(200);
    expect((await request(humanUrl)).body.goal.status).toBe('completed');
    providerMode = 'read';
    const workspaceRoot = path.join(root, 'data/groups', groups[jid].folder);
    const unsafeRuntime = `/api/groups/${encodeURIComponent(jid)}/sessions/${unsafeId}/runtime`;
    const runRead = async (marker: string) => {
      const value = await request('/api/messages', 'POST', {
        chatJid: jid,
        agentId: unsafeId,
        requestId: randomUUID(),
        content: marker,
        followUpBehavior: 'queue',
      });
      expect(value.status).toBe(200);
      await waitFor(async () =>
        (await request(unsafeRuntime)).body.inputs?.some(
          (input: any) =>
            input.id === value.body.messageId && input.state === 'completed',
        ),
      );
    };
    if (process.platform === 'linux') {
      execFileSync('mkfifo', [path.join(workspaceRoot, 'fifo-fixture')]);
      readPath = 'fifo-fixture';
      await runRead('FIFO_READ_MUST_NOT_BLOCK_SERVICE');
      expect((await request('/api/health')).status).toBe(200);
    }
    const outside = path.join(root, 'home/outside-workspace-fixture.txt');
    fs.writeFileSync(outside, 'OUTSIDE_WORKSPACE_MUST_NOT_LEAK');
    fs.linkSync(outside, path.join(workspaceRoot, 'hardlink-fixture.txt'));
    readPath = 'hardlink-fixture.txt';
    await runRead('HARDLINK_READ_MUST_BE_DENIED');
    expect(
      requests.some((item) =>
        item.messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes(
              'OUTSIDE_WORKSPACE_MUST_NOT_LEAK',
            ),
        ),
      ),
    ).toBe(false);
    readPath = 'fixture.txt';
    hold = true;
    const attemptsBefore = requests.length;
    expect(
      (
        await request('/api/messages', 'POST', {
          chatJid: jid,
          agentId: otherId,
          requestId: randomUUID(),
          content: 'Read fixture.txt in the independent session.',
          followUpBehavior: 'queue',
        })
      ).status,
    ).toBe(200);
    await waitFor(() => requests.length > attemptsBefore);
    const skewInput = await request('/api/messages', 'POST', {
      chatJid: jid,
      agentId: skewId,
      requestId: randomUUID(),
      content: 'SKEW_INPUT_MUST_NOT_REEXECUTE',
      followUpBehavior: 'queue',
    });
    expect(skewInput.status).toBe(200);
    await waitFor(() => held.size === 2);
    expect(await stop('SIGKILL')).toEqual([null, 'SIGKILL']);
    const raw = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      expect(
        raw
          .prepare('SELECT count(*) AS n FROM messages WHERE id=?')
          .get(admitted.body.messageId),
      ).toMatchObject({ n: 1 });
      expect(
        raw
          .prepare(
            'SELECT count(*) AS n FROM messages m JOIN product_input_results r ON r.message_id=m.id WHERE r.input_id=?',
          )
          .get(admitted.body.messageId),
      ).toMatchObject({ n: 1 });
      // Simulate an inconsistent cross-database restore for the first Session.
      raw
        .prepare('DELETE FROM product_session_inputs WHERE session_id=?')
        .run(id);
      raw
        .prepare(
          "UPDATE product_session_inputs SET state='completed',completed_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), skewInput.body.messageId);
    } finally {
      raw.close();
    }
    hold = false;
    await start(false);
    const otherSnapshot = `/api/groups/${encodeURIComponent(jid)}/sessions/${otherId}/runtime`;
    await waitFor(
      async () =>
        (await request(otherSnapshot)).body.inputs?.[0]?.state === 'completed',
    );
    expect((await request(snapshotUrl)).status).toBe(409);
    expect(
      (
        await request(
          `/api/groups/${encodeURIComponent(jid)}/sessions/${skewId}/runtime`,
        )
      ).status,
    ).toBe(409);
    expect(
      requests.filter((item) =>
        JSON.stringify(item.messages).includes('SKEW_INPUT_MUST_NOT_REEXECUTE'),
      ),
    ).toHaveLength(1);
    hold = true;
    const timedInput = await request('/api/messages', 'POST', {
      chatJid: jid,
      agentId: timedId,
      requestId: randomUUID(),
      content: 'Wait for duration budget fault.',
      followUpBehavior: 'queue',
    });
    expect(timedInput.status).toBe(200);
    await waitFor(() => held.size === 1);
    const clockFault = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      // Budget is active execution time, not how long the input sat in the queue.
      // Backdate the execution clock, not product_session_inputs.created_at.
      const startedAt = new Date(Date.now() - 3_600_000).toISOString();
      const clockRows = clockFault
        .prepare(
          'UPDATE product_input_clocks SET started_at=? WHERE input_id=?',
        )
        .run(startedAt, timedInput.body.messageId);
      if (clockRows.changes !== 1)
        throw new Error('Durable execution clock was not recorded');
    } finally {
      clockFault.close();
    }
    await waitFor(() => held.size === 0);
    expect(
      (
        await request(
          `/api/groups/${encodeURIComponent(jid)}/sessions/${timedId}/runtime`,
        )
      ).status,
    ).toBe(409);
    hold = true;
    expect(
      (
        await request('/api/messages', 'POST', {
          chatJid: jid,
          agentId: otherId,
          requestId: randomUUID(),
          content: 'Wait for the revocation fault.',
          followUpBehavior: 'queue',
        })
      ).status,
    ).toBe(200);
    await waitFor(() => held.size === 1);
    const revoke = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      revoke
        .prepare(
          "UPDATE users SET status='disabled' WHERE username='durable_fixture'",
        )
        .run();
    } finally {
      revoke.close();
    }
    await waitFor(() => held.size === 0); // Revocation closes the actual in-flight provider connection.
    await delay(1200);
    await stop('SIGINT');
    const count = requests.length;
    await start(false);
    expect(requests.length).toBe(count);
    const blocked = new DatabaseSync(path.join(root, 'data/db/messages.db'));
    try {
      expect(
        blocked
          .prepare(
            'SELECT state FROM product_session_runtimes WHERE session_id=?',
          )
          .get(id),
      ).toMatchObject({ state: 'blocked' });
      expect(
        blocked
          .prepare(
            'SELECT state FROM product_session_runtimes WHERE session_id=?',
          )
          .get(otherId),
      ).toMatchObject({ state: 'blocked' });
    } finally {
      blocked.close();
    }
  } finally {
    await stop('SIGINT');
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Seven real process starts use a separate cold-bootstrap allowance; each
  // business assertion still has its original 30-second deadline.
}, 600_000);
