import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { BotGroupSnapshot } from '../../src/bot-groups/types.js';

export type ModelBody = {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
};
export type ModelPlan =
  | { hold: true }
  | { error: { status: number; code: string } }
  | { text: string; usage?: { input: number; output: number } }
  | {
      tool: { name: string; arguments: Record<string, unknown> };
      usage?: { input: number; output: number };
    };
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 30000,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('Isolated Bot Handoff assertion timed out');
}
export async function botHandoffHttpFixture(
  preload?: string,
  cloudEnvironment: Record<string, string> = {},
  startupTimeoutMs = 120_000,
) {
  // macOS resolves /var to /private/var in the child process's cwd receipt.
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-bot-handoff-fault-')),
    ),
    repository = fileURLToPath(new URL('../../', import.meta.url));
  const startupMilliseconds: number[] = [];
  let port = 0,
    origin = '';
  let child: ChildProcess | undefined,
    cookie = '',
    log = '';
  let onModel: (body: ModelBody, index: number) => ModelPlan = () => ({
    text: 'BOT_FAULT_FIXTURE_DONE',
  });
  const requests: ModelBody[] = [],
    held = new Set<ServerResponse>();
  let modelEvent = 0;
  const modelIntervals: {
    index: number;
    started_at: number;
    ended_at: number | null;
    started_order: number;
    ended_order: number | null;
    termination: 'finished' | 'disconnected' | null;
  }[] = [];
  const heldBodies = new Map<ServerResponse, ModelBody>();
  function answer(
    response: ServerResponse,
    plan: Exclude<ModelPlan, { hold: true }>,
  ) {
    if ('error' in plan) {
      response.writeHead(plan.error.status, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          error: {
            type: 'server_error',
            message: plan.error.code,
            code: plan.error.code,
          },
        }),
      );
      return;
    }
    const delta =
      'text' in plan
        ? { role: 'assistant', content: plan.text }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'bounded-group-call',
                type: 'function',
                function: {
                  name: plan.tool.name,
                  arguments: JSON.stringify(plan.tool.arguments),
                },
              },
            ],
          };
    const packet = (value: unknown, reason: string | null) =>
      `data: ${JSON.stringify({ id: 'bot-fault-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      packet(delta, null) +
        packet({}, 'text' in plan ? 'stop' : 'tool_calls') +
        (plan.usage
          ? `data: ${JSON.stringify({ id: 'bot-fault-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [], usage: { prompt_tokens: plan.usage.input, completion_tokens: plan.usage.output, total_tokens: plan.usage.input + plan.usage.output } })}\n\n`
          : '') +
        'data: [DONE]\n\n',
    );
  }
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw) as ModelBody;
    requests.push(body);
    const interval = {
      index: requests.length,
      started_at: Date.now(),
      ended_at: null as number | null,
      started_order: ++modelEvent,
      ended_order: null as number | null,
      termination: null as 'finished' | 'disconnected' | null,
    };
    modelIntervals.push(interval);
    response.once('finish', () => {
      interval.ended_at = Date.now();
      interval.ended_order = ++modelEvent;
      interval.termination = 'finished';
    });
    response.once('close', () => {
      if (interval.ended_at === null) {
        interval.ended_at = Date.now();
        interval.ended_order = ++modelEvent;
        interval.termination = 'disconnected';
      }
    });
    const plan = onModel(body, requests.length);
    if ('hold' in plan) {
      held.add(response);
      heldBodies.set(response, body);
      response.once('close', () => {
        held.delete(response);
        heldBodies.delete(response);
      });
      return;
    }
    answer(response, plan);
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
    const updated = response.headers.get('set-cookie');
    if (updated) cookie = updated.split(';')[0];
    return response;
  };
  const start = async (preload?: string) => {
    const listeners = new Set<number>();
    const receipts = { received: 0, wrongPid: 0, wrongRoot: 0, invalidPort: 0 };
    let lastProbe:
      | {
          port: number;
          status?: number;
          healthy?: boolean;
          database?: boolean;
          queue?: boolean;
          errorCode?: string;
        }
      | undefined;
    const requestedPort = port;
    const processStartedAt = Date.now();
    child = spawn(
      process.execPath,
      [
        '--import',
        path.join(repository, 'tests/helpers/announce-listening.mjs'),
        ...(preload ? ['--import', preload] : []),
        path.join(repository, 'dist/index.js'),
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, 'home'),
          WEB_PORT: String(port),
          CORS_ALLOWED_ORIGINS: origin,
          ADMIN_HOST_ONLY_MODE: 'true',
          // Do not scan/install unrelated host marketplace plugins in this fixture.
          PLUGIN_AUTO_SCAN: 'false',
          MINICLAW_DURABLE_RUNTIME: 'true',
          MINICLAW_BOT_GROUPS: 'true',
          MINICLAW_BOT_HANDOFFS: 'true',
          TZ: 'UTC',
          ...cloudEnvironment,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    child.on('message', (raw: unknown) => {
      const value = raw as {
        type?: string;
        pid?: number;
        root?: string;
        port?: number;
      };
      if (value.type === 'miniclaw_fixture_listening_v1') {
        receipts.received++;
        if (value.pid !== child?.pid) receipts.wrongPid++;
        if (value.root !== root) receipts.wrongRoot++;
        if (
          !Number.isInteger(value.port) ||
          value.port! <= 0 ||
          value.port! > 65535 ||
          (requestedPort !== 0 && value.port !== requestedPort)
        )
          receipts.invalidPort++;
      }
      if (
        value.type !== 'miniclaw_fixture_listening_v1' ||
        value.pid !== child?.pid ||
        value.root !== root ||
        !Number.isInteger(value.port) ||
        value.port! <= 0 ||
        value.port! > 65535 ||
        (requestedPort !== 0 && value.port !== requestedPort)
      )
        return;
      listeners.add(value.port!);
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (part) => {
        log = (log + part.toString()).slice(-25000);
      });
    await waitFor(async () => {
      if (child?.exitCode !== null || child?.signalCode !== null)
        throw new Error('Private backend exited before its listening receipt');
      // Auxiliary HTTP/HTTPS helpers can listen in the same process before
      // Web. An owned listening receipt is a candidate, not readiness proof.
      for (const candidate of listeners) {
        const candidateOrigin = `http://127.0.0.1:${candidate}`;
        lastProbe = { port: candidate };
        try {
          const response = await fetch(candidateOrigin + '/api/health', {
            signal: AbortSignal.timeout(1000),
          });
          lastProbe.status = response.status;
          if (response.status !== 200) {
            await response.body?.cancel();
            continue;
          }
          const health = (await response.json()) as {
            status?: string;
            checks?: { database?: boolean; queue?: boolean };
          };
          lastProbe.healthy = health.status === 'healthy';
          lastProbe.database = health.checks?.database === true;
          lastProbe.queue = health.checks?.queue === true;
          if (
            health.status !== 'healthy' ||
            health.checks?.database !== true ||
            health.checks?.queue !== true
          )
            continue;
          port = candidate;
          origin = candidateOrigin;
          return true;
        } catch (error) {
          const code = (error as { cause?: { code?: unknown } })?.cause?.code;
          if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code))
            lastProbe.errorCode = code;
          // A non-Web listener must not hide a later valid Web receipt.
        }
      }
      return false;
    }, startupTimeoutMs).catch((error: unknown) => {
      if (error instanceof Error)
        Object.assign(error, {
          startupEvidence: {
            deadlineMs: startupTimeoutMs,
            elapsedMs: Date.now() - processStartedAt,
            requestedPort,
            pid: child?.pid,
            exitCode: child?.exitCode,
            signalCode: child?.signalCode,
            receipts,
            listeningPorts: [...listeners],
            lastProbe,
            webStarted: log.includes('Web server started'),
          },
        });
      throw error;
    });
    startupMilliseconds.push(Date.now() - processStartedAt);
    if (process.env.MINICLAW_FIXTURE_TIMING === '1')
      console.info(
        JSON.stringify({
          phase: 'backend-ready',
          milliseconds: startupMilliseconds.at(-1),
        }),
      );
  };
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stoppedAt = Date.now();
      if (process.env.MINICLAW_FIXTURE_TIMING === '1')
        console.info(JSON.stringify({ phase: 'backend-stop-begin', signal }));
      const exited = once(child, 'exit');
      child.kill(signal);
      await exited;
      if (process.env.MINICLAW_FIXTURE_TIMING === '1')
        console.info(
          JSON.stringify({
            phase: 'backend-stop-done',
            signal,
            milliseconds: Date.now() - stoppedAt,
          }),
        );
    }
  };
  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok)
      throw new Error(`Private fixture API rejected with ${response.status}`);
    return response.json() as Promise<T>;
  };
  const snapshot = async (groupId: string) =>
    json<BotGroupSnapshot>(await call(`/api/bot-groups/${groupId}`));
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
    await start(preload);
    const password = `Bots9!${randomBytes(20).toString('hex')}`;
    await json(
      await call('/api/auth/setup', 'POST', {
        username: 'bot_fault_owner',
        password,
      }),
    );
    await json(
      await call('/api/config/claude/providers', 'POST', {
        name: 'Synthetic fault-only model',
        type: 'third_party',
        anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        anthropicApiKey: 'synthetic-bot-fault-key',
        anthropicModel: 'fixture-model',
        customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
      }),
    );
    const options = await json<{ workspaces: { jid: string }[] }>(
      await call('/api/bot-groups/options'),
    );
    const createGroup = async (
      tools: string[] = [],
      max = 4,
      runtimeKind: 'node-durable' | 'cloudflare-durable' = 'node-durable',
    ) => {
      let state = (
        await json<{ snapshot: BotGroupSnapshot }>(
          await call('/api/bot-groups', 'POST', {
            workspace_jid: options.workspaces[0].jid,
            name: 'Native fault team',
          }),
        )
      ).snapshot;
      const groupId = state.group.id,
        chief = state.members.find((member) => member.kind === 'bot')!;
      state = (
        await json<{ snapshot: BotGroupSnapshot }>(
          await call(
            `/api/bot-groups/${groupId}/members/${chief.id}`,
            'PATCH',
            {
              scope_workspace_jid: options.workspaces[0].jid,
              expected_revision: state.revision,
            },
          ),
        )
      ).snapshot;
      await json(
        await call(
          `/api/bot-groups/${groupId}/members/${chief.id}/runtime-grants`,
          'POST',
          {
            expected_revision: state.revision,
            expected_member_revision: state.members.find(
              (member) => member.id === chief.id,
            )!.revision,
            runtime_kind: runtimeKind,
            max_model_attempts: max,
            tool_capabilities: tools,
          },
        ),
      );
      return {
        groupId,
        memberId: chief.id,
        profileId: chief.subject_id,
        workspaceJid: options.workspaces[0].jid,
      };
    };
    return {
      root,
      startupMilliseconds,
      credentials: { username: 'bot_fault_owner', password },
      origin,
      requests,
      modelIntervals,
      held,
      call,
      json,
      snapshot,
      createGroup,
      start,
      stop,
      setModel: (value: typeof onModel) => {
        onModel = value;
      },
      release: (plan: Exclude<ModelPlan, { hold: true }>) => {
        for (const response of [...held]) {
          held.delete(response);
          heldBodies.delete(response);
          answer(response, plan);
        }
      },
      releaseMatching: (
        check: (body: ModelBody) => boolean,
        plan: Exclude<ModelPlan, { hold: true }>,
      ) => {
        let released = 0;
        for (const [response, body] of [...heldBodies])
          if (check(body)) {
            held.delete(response);
            heldBodies.delete(response);
            answer(response, plan);
            released++;
          }
        return released;
      },
      diagnostics: () => log,
      getChild: () => child,
      dispose: async () => {
        for (const response of held) response.destroy();
        await stop();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    const startupEvidence = {
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
      webStarted: log.includes('Web server started'),
      signals: [
        'EADDRINUSE',
        'SQLITE_BUSY',
        'SQLITE_CORRUPT',
        'ERR_MODULE_NOT_FOUND',
      ].filter((code) => log.includes(code)),
    };
    if (error instanceof Error) {
      const evidence = {
        ...(error as Error & { startupEvidence?: object }).startupEvidence,
        ...startupEvidence,
      };
      Object.assign(error, { startupEvidence: evidence });
      // Vitest's default reporter does not print custom Error properties.
      // Keep the sanitized readiness receipt visible when startup times out.
      error.message += `; startup evidence: ${JSON.stringify(evidence)}`;
    }
    await stop();
    for (const response of held) response.destroy();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
