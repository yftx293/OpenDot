// Actual workerd <-> Node HTTP/encrypted Provider <-> fixture model. Memory and
// authorization storage are real product code; model inference is simulated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { afterAll, expect, test, vi } from 'vitest';
import type { CloudBinding } from '../src/personal-agent/cloud-wire.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-memory-http-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const store = await import('../src/personal-agent/product-runtime-store.js');
const config = await import('../src/runtime-config.js');
const models = await import('../src/personal-agent/product-model.js');
const runtime = await import('../src/personal-agent/product-runtime.js');
const memory = await import('../src/personal-agent/personal-memory-store.js');
const host = await import('../src/host-execution-policy.js');
const wire = await import('../src/personal-agent/cloud-wire.js');
const routes = (await import('../src/routes/cloud-runtime.js')).default;
interface WorkerRuntime {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}
const requireCloud = createRequire(
  new URL('../apps/cloud-agent/package.json', import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = requireCloud('miniflare') as {
  Miniflare: new (options: Record<string, unknown>) => WorkerRuntime;
  convertV4MiniflareOptions: (
    options: Record<string, unknown>,
  ) => Record<string, unknown>;
};
let worker: WorkerRuntime | undefined;
const servers: Server[] = [];
afterAll(async () => {
  host.endHostPrivilegeRevocation('alice');
  await worker?.dispose();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await runtime.getProductRuntimeService().close();
  db.closeDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Cloud native Memory tools use real product grants and audit, survive restart, and cannot read revoked sources', async () => {
  const secret = 'local-cloud-memory-control-fixture-key';
  vi.stubEnv('MINICLAW_CLOUD_SHARED_SECRET', secret);
  vi.stubEnv('MINICLAW_CLOUD_MEMORY', 'true');
  vi.stubEnv('MINICLAW_PERSONAL_MEMORY', 'true');
  db.initDatabase();
  runtime.startProductRuntimeService();
  const now = new Date().toISOString();
  db.createUser({
    id: 'alice',
    username: 'alice',
    password_hash: 'fixture',
    display_name: 'Alice',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  for (const suffix of ['home', 'project'])
    db.setRegisteredGroup(`web:alice-${suffix}`, {
      name: suffix,
      folder: `alice-${suffix}`,
      created_by: 'alice',
      executionMode: 'host',
      is_home: suffix === 'home',
      added_at: now,
    });
  const evidence = `explicit-memory-${randomUUID()}`;
  const entry = memory.createPersonalMemoryEntry(
    'alice',
    randomUUID(),
    {
      content: evidence,
      confirmed: true,
      allowed_workspaces: ['web:alice-project'],
    },
    () => {
      throw new Error('No artifact source');
    },
  ).entry;
  const privateEvidence = `private-memory-${randomUUID()}`;
  memory.createPersonalMemoryEntry(
    'alice',
    randomUUID(),
    { content: privateEvidence, confirmed: true, allowed_workspaces: [] },
    () => {
      throw new Error('No artifact source');
    },
  );
  const received: {
    messages: { role: string; content?: unknown }[];
    tools?: { function: { name: string } }[];
  }[] = [];
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as (typeof received)[number];
    received.push(input);
    expect(request.headers.authorization).toBe(
      'Bearer synthetic-cloud-memory-provider-key',
    );
    const last = input.messages.at(-1)!;
    const hasResult = last.role === 'tool';
    const delta = hasResult
      ? {
          role: 'assistant',
          content: JSON.stringify(last.content).includes(evidence)
            ? 'MEMORY_GRANTED'
            : 'MEMORY_EMPTY',
        }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'native-memory-call',
              type: 'function',
              function: {
                name: 'read_personal_memory',
                arguments: '{"query":"memory-"}',
              },
            },
          ],
        };
    const packet = (value: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: 'memory-model-fixture', object: 'chat.completion.chunk', created: 1, model: 'memory-model', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      packet(delta, null) +
        packet({}, hasResult ? 'stop' : 'tool_calls') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  servers.push(provider);
  await once(provider, 'listening');
  const p = config.createProvider({
    name: 'Cloud Memory HTTP fixture',
    type: 'third_party',
    anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    anthropicApiKey: 'synthetic-cloud-memory-provider-key',
    anthropicModel: 'memory-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  });
  const authority = serve({
    fetch: (request) => routes.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
  }) as Server;
  servers.push(authority);
  if (!authority.listening) await once(authority, 'listening');
  const authorityPort = (authority.address() as { port: number }).port;
  const selected = models.productModelConfiguration('web:alice-project', p.id);
  const id = randomUUID();
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice-project',
      group_folder: 'alice-project',
      name: 'Cloud Memory',
      kind: 'conversation',
      prompt: '',
      status: 'idle',
      created_by: 'alice',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    {
      kind: 'pi-durable',
      providerId: p.id,
      configFingerprint: selected.fingerprint,
      cloud: {
        runtime_id: randomUUID(),
        gateway_origin: 'https://cloud.fixture',
        model_id: selected.modelId,
        instructions: 'Read only explicitly authorized Personal Memory.',
        max_model_steps: 12,
        deadline_at: Date.now() + 60000,
        tool_capabilities: ['read_personal_memory'],
      },
    },
  );
  db.ensureChatExists(`web:alice-project#agent:${id}`);
  const binding = JSON.parse(
    store.getCloudPlacement(id)!.binding_json,
  ) as CloudBinding;
  let toolRequests = 0;
  const start = (admission: boolean) =>
    new Miniflare(
      convertV4MiniflareOptions({
        name: 'miniclaw-cloud-memory',
        modules: true,
        modulesRoot: path.resolve('.'),
        scriptPath: path.resolve('apps/cloud-agent/dist/worker.js'),
        telemetry: { enabled: false },
        compatibilityDate: '2026-10-13',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          SESSIONS: { className: 'CloudSession', useSQLite: true },
        },
        resourcePersistencePath: path.join(root, 'workerd'),
        bindings: {
          MINICLAW_CLOUD_ADMISSION: String(admission),
          MINICLAW_CLOUD_SHARED_SECRET: secret,
          MINICLAW_CLOUD_ORIGIN: 'https://cloud.fixture',
          MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
        },
        serviceBindings: {
          MINICLAW_AUTHORITY_SERVICE: async (request: Request) => {
            if (new URL(request.url).pathname.endsWith('/tools'))
              toolRequests++;
            return fetch(
              `http://127.0.0.1:${authorityPort}${new URL(request.url).pathname}`,
              {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body: await request.text(),
                redirect: 'error',
                signal: request.signal,
              },
            );
          },
        },
      }),
    );
  async function call(suffix = '', method = 'GET', input?: unknown) {
    const url = `https://cloud.fixture/internal/cloud-sessions${suffix === 'create' ? '' : `/${id}${suffix}`}`;
    const signed = await wire.signedRequest(
      secret,
      binding,
      url,
      method,
      input === undefined ? '' : JSON.stringify(input),
    );
    return worker!.dispatchFetch(url, {
      method,
      headers: Object.fromEntries(signed.headers),
      body: method === 'GET' ? undefined : await signed.text(),
    });
  }
  worker = start(true);
  const provision = await call('create', 'POST', binding);
  expect(provision.status).toBe(200);
  const created = (await provision.json()) as { conversation_id: number };
  store.bindProductConversation(id, created.conversation_id);
  async function submit(content: string, timeout = 5000) {
    const key = randomUUID();
    const receipt = store.admitProductInput(
      id,
      key,
      {
        content,
        followUpBehavior: 'queue',
        sender: 'alice',
        senderName: 'Alice',
      },
      () => {},
    );
    const response = await call('/messages', 'POST', {
      request_id: key,
      content,
      product_receipt_digest: receipt.payload_digest,
    });
    expect(response.status).toBe(202);
    const ack = (await response.json()) as {
      receipt: { submission_id: number };
    };
    store.markProductInputSubmitted(receipt.id, ack.receipt.submission_id);
    await expect
      .poll(
        () =>
          store.listProductInputs(id).find((input) => input.request_id === key)
            ?.state,
        { timeout },
      )
      .toBe('completed');
    return receipt;
  }
  const first = await submit('Read my explicitly saved memory');
  expect(received).toHaveLength(2);
  expect(received[0].tools?.map((tool) => tool.function.name)).toEqual([
    'inspect_text',
    'read_personal_memory',
  ]);
  expect(JSON.stringify(received[1].messages)).toContain(evidence);
  expect(JSON.stringify(received)).not.toContain(privateEvidence);
  const raw = new Database(path.join(root, 'db/messages.db'));
  const reads = () =>
    raw
      .prepare(
        'SELECT tool_task_id,entries FROM personal_memory_reads WHERE session_id=? ORDER BY tool_task_id',
      )
      .all(id) as { tool_task_id: number; entries: string }[];
  try {
    expect(reads()).toHaveLength(1);
    expect(reads()[0].tool_task_id).toBeGreaterThan(0);
    expect(JSON.parse(reads()[0].entries)).toMatchObject([
      { id: entry.item.id, revision: 1 },
    ]);
    const before = await (await call()).json();
    await worker.dispose();
    worker = start(false);
    const after = (await (await call()).json()) as {
      inputs: unknown[];
      view: unknown;
    };
    expect(after.inputs).toEqual((before as typeof after).inputs);
    expect(received).toHaveLength(2);
    expect(toolRequests).toBe(1);
    memory.updatePersonalMemoryEntry('alice', entry.item.id, randomUUID(), {
      expected_revision: 1,
      content: evidence,
      confirmed: true,
      allowed_workspaces: [],
    });
    // An interrupted singleflight result job retains the SDK's 30-second hung
    // lease. Exercise its real Alarm recovery rather than resetting SDK rows.
    const second = await submit('Read current authorized memory again', 40000);
    expect(first.id).not.toBe(second.id);
    expect(received).toHaveLength(4);
    const lastTool = received[3].messages
      .filter((message) => message.role === 'tool')
      .at(-1)!;
    expect(String(lastTool.content)).toContain('"entries":[]');
    expect(String(lastTool.content)).not.toContain(evidence);
    expect(reads()).toHaveLength(2);
    expect(reads()[1].tool_task_id).not.toBe(reads()[0].tool_task_id);
    expect(JSON.parse(reads()[1].entries)).toEqual([]);
    expect(toolRequests).toBe(2);
    host.beginHostPrivilegeRevocation('alice');
    expect((await call()).status).toBe(409);
    expect(toolRequests).toBe(2);
    expect(
      fs.existsSync(path.join(root, 'db/durable-sessions', id + '.sqlite')),
    ).toBe(false);
  } finally {
    raw.close();
  }
}, 60000);
