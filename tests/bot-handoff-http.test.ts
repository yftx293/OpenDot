// Actual compiled MiniClaw HTTP process + official Pi Durable SQLite/Task owner.
// The loopback OpenAI SSE response is synthetic; no live vendor is exercised.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type {
  BotGroupSnapshot,
  GroupReceipt,
} from '../src/bot-groups/types.js';
const waitFor = async (
  check: () => Promise<boolean> | boolean,
  timeoutMs = 30000,
  phase = 'execution',
) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(
    `Private Bot Handoff ${phase} timed out after ${timeoutMs} ms`,
  );
};
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}

test('the formal Group message API dispatches only its authorized Chief and projects an actual native Submission/Task answer once (HTTP model simulated)', async () => {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'miniclaw-bot-native-http-'),
    ),
    repository = process.cwd();
  const origin = `http://127.0.0.1:${await port()}`;
  let child: ChildProcess | undefined,
    cookie = '',
    log = '',
    calls = 0;
  const modelBodies: Record<string, unknown>[] = [];
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    calls++;
    modelBodies.push(body);
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(
      'Bearer synthetic-bot-native-key',
    );
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta: unknown, reason: string | null) =>
      `data: ${JSON.stringify({ id: 'native-group-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    response.end(
      packet(
        { role: 'assistant', content: 'NATIVE_GROUP_CHIEF_RESULT' },
        null,
      ) +
        packet({}, 'stop') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const call = async (
    url: string,
    method = 'GET',
    body?: unknown,
    key = randomUUID(),
  ) => {
    const response = await fetch(origin + url, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  try {
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default-groups.json'), '[]');
    for (const directory of ['web', 'container'])
      fs.symlinkSync(
        path.join(repository, directory),
        path.join(root, directory),
        'dir',
      );
    child = spawn(process.execPath, [path.join(repository, 'dist/index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        WEB_PORT: new URL(origin).port,
        CORS_ALLOWED_ORIGINS: origin,
        ADMIN_HOST_ONLY_MODE: 'true',
        MINICLAW_DURABLE_RUNTIME: 'true',
        MINICLAW_BOT_GROUPS: 'true',
        MINICLAW_BOT_HANDOFFS: 'true',
        TZ: 'UTC',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => {
        log = (log + chunk.toString()).slice(-20000);
      });
    // Match the shared process fixture's startup budget; the native answer
    // below still has its original 30-second execution deadline.
    await waitFor(
      async () => {
        if (child?.exitCode !== null || child?.signalCode !== null)
          throw new Error('Private backend exited before readiness');
        try {
          return (await call('/api/health')).status === 200;
        } catch {
          return false;
        }
      },
      120000,
      'startup',
    );
    expect(
      (
        await call('/api/auth/setup', 'POST', {
          username: 'bot_native_owner',
          password: `Bots9!${randomBytes(20).toString('hex')}`,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call('/api/config/claude/providers', 'POST', {
          name: 'Synthetic Bot Native Provider',
          type: 'third_party',
          anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
          anthropicApiKey: 'synthetic-bot-native-key',
          anthropicModel: 'fixture-model',
          customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
        })
      ).status,
    ).toBe(201);
    const options = (await (await call('/api/bot-groups/options')).json()) as {
      workspaces: { jid: string }[];
    };
    expect(options.workspaces).toHaveLength(1);
    const created = await call('/api/bot-groups', 'POST', {
      workspace_jid: options.workspaces[0].jid,
      name: 'Native Chief Team',
    });
    expect(created.status).toBe(201);
    let snapshot = ((await created.json()) as { snapshot: BotGroupSnapshot })
      .snapshot;
    const groupId = snapshot.group.id,
      chief = snapshot.members.find((member) => member.kind === 'bot')!;
    const scoped = await call(
      `/api/bot-groups/${groupId}/members/${chief.id}`,
      'PATCH',
      {
        scope_workspace_jid: options.workspaces[0].jid,
        expected_revision: snapshot.revision,
      },
    );
    expect(scoped.status).toBe(200);
    snapshot = ((await scoped.json()) as { snapshot: BotGroupSnapshot })
      .snapshot;
    expect(
      await (await call('/api/bot-groups/availability')).json(),
    ).toMatchObject({
      cloud_handoffs_enabled: false,
      cloud_approvals_enabled: false,
    });
    const cloudDenied = await call(
      `/api/bot-groups/${groupId}/members/${chief.id}/runtime-grants`,
      'POST',
      {
        expected_revision: snapshot.revision,
        expected_member_revision: snapshot.members.find(
          (member) => member.id === chief.id,
        )!.revision,
        runtime_kind: 'cloudflare-durable',
        tool_capabilities: [],
      },
    );
    expect(cloudDenied.status).toBe(409);
    expect(await cloudDenied.json()).toMatchObject({
      code: 'BOT_HANDOFF_CLOUD_ADMISSION_DISABLED',
    });
    const grant = await call(
      `/api/bot-groups/${groupId}/members/${chief.id}/runtime-grants`,
      'POST',
      {
        expected_revision: snapshot.revision,
        expected_member_revision: snapshot.members.find(
          (member) => member.id === chief.id,
        )!.revision,
        runtime_kind: 'node-durable',
        max_model_attempts: 2,
        tool_capabilities: [],
      },
    );
    expect(grant.status).toBe(200);
    const requestId = randomUUID(),
      input = { content: '@Chief Analyze only this shared request.' };
    const accepted = await call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      input,
      requestId,
    );
    expect(accepted.status).toBe(202);
    const receipt = ((await accepted.json()) as { receipt: GroupReceipt })
      .receipt;
    await waitFor(async () => {
      snapshot = (await (
        await call(`/api/bot-groups/${groupId}`)
      ).json()) as BotGroupSnapshot;
      return snapshot.handoffs?.[0]?.state === 'completed';
    });
    const handoff = snapshot.handoffs![0];
    expect(handoff).toMatchObject({
      source_message_id: receipt.message_id,
      target_bot_id: chief.subject_id,
      source_bot_id: null,
      runtime_kind: 'node-durable',
      model_attempts: 1,
    });
    expect(handoff.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(handoff.submission_id).toBeGreaterThan(0);
    expect(handoff.task_id).toBeGreaterThan(0);
    const answer = snapshot.messages.filter(
      (message) => message.author_kind === 'bot',
    );
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({
      content: 'NATIVE_GROUP_CHIEF_RESULT',
      author_id: chief.subject_id,
      author_name: chief.display_name,
      source: {
        kind: 'native_handoff_result',
        handoff_id: handoff.id,
        session_id: handoff.session_id,
        submission_id: handoff.submission_id,
        task_id: handoff.task_id,
        answer_entry_id: handoff.answer_entry_id,
        result_digest: handoff.result_digest,
      },
    });
    const replay = await call(
      `/api/bot-groups/${groupId}/messages`,
      'POST',
      input,
      requestId,
    );
    expect(replay.status).toBe(202);
    expect(
      ((await replay.json()) as { receipt: GroupReceipt }).receipt,
    ).toEqual({ ...receipt, replayed: true });
    expect(calls).toBe(1);
    expect(modelBodies[0].tools ?? []).toEqual([]);
    const database = new Database(path.join(root, 'data/db/messages.db'), {
      readonly: true,
    });
    try {
      expect(
        database
          .prepare(
            'SELECT submission_id FROM product_session_inputs WHERE session_id=?',
          )
          .all(handoff.session_id),
      ).toEqual([{ submission_id: handoff.submission_id }]);
      expect(
        database
          .prepare(
            'SELECT task_id,answer_entry_id,result_digest FROM product_input_task_sources WHERE input_id=?',
          )
          .get(handoff.input_id),
      ).toEqual({
        task_id: handoff.task_id,
        answer_entry_id: handoff.answer_entry_id,
        result_digest: handoff.result_digest,
      });
      expect(
        database.prepare('SELECT count(*) AS n FROM scheduled_tasks').get(),
      ).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nModel fixture calls: ${calls}\nPrivate fixture backend:\n${log}`,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
