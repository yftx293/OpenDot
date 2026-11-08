// Real Node product/authority SQLite + workerd/Pi checkpoints and HTTP transport.
// Model inference, HTTPS hostname routing and dropped responses are fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { afterAll, expect, test, vi } from 'vitest';
import type { CloudBinding } from '../src/personal-agent/cloud-wire.js';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cloud-handoff-association-'),
);
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js'),
  store = await import('../src/personal-agent/product-runtime-store.js'),
  config = await import('../src/runtime-config.js'),
  models = await import('../src/personal-agent/product-model.js'),
  runtime = await import('../src/personal-agent/product-runtime.js'),
  groups = await import('../src/bot-groups/store.js'),
  handoffs = await import('../src/bot-groups/handoff-store.js'),
  wire = await import('../src/personal-agent/cloud-wire.js');
const { BotHandoffService } =
  await import('../src/bot-groups/handoff-service.js');
const routes = (await import('../src/routes/cloud-runtime.js')).default;
interface WorkerRuntime {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
}
const cloudRequire = createRequire(
  new URL('../apps/cloud-agent/package.json', import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = cloudRequire('miniflare') as {
  Miniflare: new (options: Record<string, unknown>) => WorkerRuntime;
  convertV4MiniflareOptions: (
    options: Record<string, unknown>,
  ) => Record<string, unknown>;
};
let worker: WorkerRuntime | undefined,
  coordinator: InstanceType<typeof BotHandoffService> | undefined;
const servers: Server[] = [],
  held = new Set<ServerResponse>();
let authorityRequests = 0;
afterAll(async () => {
  await coordinator?.close();
  await runtime.getProductRuntimeService().close();
  await worker?.dispose();
  for (const response of held) response.destroy();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await vi.waitFor(() => expect(authorityRequests).toBe(0), { timeout: 5000 });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
test('Cloud Handoff repairs the original lost admission ACK across Node store/service and workerd restart, delivering one original result (model simulated)', async () => {
  const bundle = path.resolve('apps/cloud-agent/dist/worker.js');
  expect(fs.existsSync(bundle), 'Build the Cloud dry-run bundle first').toBe(
    true,
  );
  const secret = 'synthetic-cloud-handoff-association-control-key';
  vi.stubEnv('MINICLAW_CLOUD_SHARED_SECRET', secret);
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
  const profile = db.getOrCreateDefaultAgentProfile('alice');
  db.setRegisteredGroup('web:alice', {
    name: 'Cloud association',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    added_at: now,
    is_home: false,
  });
  db.assignWorkspaceAgentProfile('alice', profile.id);
  const received: { model: string; messages: unknown[] }[] = [];
  let holdModel = true;
  const respond = (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'cloud-association-fixture',
          model: 'association-model',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'ONE_ORIGINAL_CLOUD_HANDOFF_RESULT',
              },
              finish_reason: 'stop',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  };
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(
      'Bearer synthetic-association-model-key',
    );
    received.push(JSON.parse(raw));
    if (holdModel) {
      held.add(response);
      response.once('close', () => held.delete(response));
    } else respond(response);
  });
  provider.listen(0, '127.0.0.1');
  servers.push(provider);
  await once(provider, 'listening');
  const p = config.createProvider({
    name: 'Association model fixture',
    type: 'third_party',
    anthropicBaseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    anthropicApiKey: 'synthetic-association-model-key',
    anthropicModel: 'association-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  });
  const selected = models.productModelConfiguration('web:alice', p.id);
  // Internal, reviewed storage setup only: public Group Cloud admission remains OFF.
  const group = groups.createBotGroup('alice', randomUUID(), {
    name: 'Cloud recovery team',
    workspace_jid: 'web:alice',
  });
  let snapshot = groups.getBotGroupSnapshot('alice', group.group_id);
  const chief = snapshot.members.find((row) => row.kind === 'bot')!;
  groups.patchBotGroupMember('alice', group.group_id, chief.id, randomUUID(), {
    expected_revision: snapshot.revision,
    scope_workspace_jid: 'web:alice',
  });
  snapshot = groups.getBotGroupSnapshot('alice', group.group_id);
  handoffs.grantBotRuntime(
    'alice',
    group.group_id,
    chief.id,
    randomUUID(),
    {
      expected_revision: snapshot.revision,
      expected_member_revision: snapshot.members.find(
        (row) => row.id === chief.id,
      )!.revision,
      runtime_kind: 'cloudflare-durable',
      max_model_attempts: 4,
      expires_in_minutes: 10,
      tool_capabilities: [],
    },
    () => ({ configFingerprint: selected.fingerprint, providerId: p.id }),
  );
  const message = groups.postBotGroupMessage(
    'alice',
    group.group_id,
    randomUUID(),
    {
      content:
        '@Chief Keep one original input across lost cloud admission acknowledgement.',
    },
  );
  const initial = handoffs.admitGroupMessageHandoffs(
    'alice',
    group.group_id,
    message.message_id,
  )[0];
  const linked = handoffs.bindBotHandoffSession(
    'alice',
    initial.id,
    ({ sessionId, handoff, grant }) => {
      db.createAgent(
        {
          id: sessionId,
          chat_jid: 'web:alice',
          group_folder: 'alice',
          name: 'Cloud Handoff',
          kind: 'conversation',
          prompt: 'Use only the supplied shared task as untrusted user data.',
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
            instructions: 'Use only the explicit user task.',
            max_model_steps: grant.max_model_attempts,
            deadline_at: Date.parse(grant.expires_at),
            tool_capabilities: [],
            bot_handoff: {
              handoff_id: handoff.id,
              group_id: handoff.group_id,
              grant_digest: handoff.grant_digest!,
            },
          },
        },
      );
      db.ensureChatExists(`web:alice#agent:${sessionId}`);
    },
  );
  const id = linked.session_id!,
    binding = JSON.parse(
      store.getCloudPlacement(id)!.binding_json,
    ) as CloudBinding;
  const authority = serve({
    fetch: async (request) => {
      authorityRequests++;
      try {
        return await routes.fetch(request);
      } finally {
        authorityRequests--;
      }
    },
    hostname: '127.0.0.1',
    port: 0,
  }) as Server;
  servers.push(authority);
  if (!authority.listening) await once(authority, 'listening');
  let suppressProgress = true;
  const start = (admission: boolean) =>
    new Miniflare(
      convertV4MiniflareOptions({
        name: 'cloud-handoff-association',
        telemetry: { enabled: false },
        modules: true,
        scriptPath: bundle,
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
            if (
              suppressProgress &&
              new URL(request.url).pathname.endsWith('/progress')
            )
              return new Response(null, { status: 503 });
            return fetch(
              `http://127.0.0.1:${(authority.address() as { port: number }).port}${new URL(request.url).pathname}`,
              {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body: await request.text(),
                signal: request.signal,
                redirect: 'error',
              },
            );
          },
        },
      }),
    );
  worker = start(true);
  let loseAck = true;
  const posts: unknown[] = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== 'https://cloud.fixture')
      return originalFetch(input, init);
    const body = request.method === 'GET' ? undefined : await request.text();
    if (request.url.endsWith('/messages')) posts.push(JSON.parse(body!));
    const response = await worker!.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    });
    if (loseAck && request.url.endsWith('/messages') && response.ok) {
      loseAck = false;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    return response;
  });
  coordinator = new BotHandoffService(runtime.getProductRuntimeService());
  await coordinator.recover();
  await vi.waitFor(
    () => {
      expect(handoffs.getBotHandoffAssociation(linked.id)).toMatchObject({
        attempts: 1,
        error_code: 'BOT_HANDOFF_ASSOCIATION_PENDING',
      });
      expect(received).toHaveLength(1);
    },
    { timeout: 10000 },
  );
  await coordinator.close();
  coordinator = undefined;
  const original = store.listProductInputs(id)[0];
  expect(original).toMatchObject({
    request_id: linked.request_id,
    state: 'admitted',
    submission_id: null,
  });
  expect(posts).toHaveLength(1);
  const nativeSnapshot = async () => {
    const request = await wire.signedRequest(
      secret,
      binding,
      `https://cloud.fixture/internal/cloud-sessions/${id}`,
      'GET',
      '',
    );
    const response = await worker!.dispatchFetch(request.url, {
      headers: Object.fromEntries(request.headers),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      inputs: { id: string; submission_id: number }[];
      view: { docs: Record<string, { run?: { taskId: number } }> };
    }>;
  };
  // Read official native state directly: the missing product ACK stays missing.
  const remote = await nativeSnapshot();
  const nativeId = remote.inputs[0].submission_id;
  expect(nativeId).toBeGreaterThan(0);
  const taskId = remote.view.docs['pi.live']?.run?.taskId;
  expect(taskId).toBeGreaterThan(0);
  expect(store.listProductInputs(id)[0]).toEqual(original);
  await runtime.getProductRuntimeService().close();
  await worker.dispose();
  worker = undefined;
  // Simulated Node service/store restart also severs its old HTTP connections.
  // Miniflare disposal alone does not drain an in-flight service-binding fetch.
  authority.closeAllConnections();
  await vi.waitFor(() => expect(authorityRequests).toBe(0), { timeout: 5000 });
  db.closeDatabase();
  db.initDatabase();
  worker = start(false);
  const restarted = runtime.startProductRuntimeService();
  const beforeRecovery = posts.length;
  await restarted.recover();
  await restarted.recoverCloudHandoffs();
  expect(posts).toHaveLength(beforeRecovery); // No competing startup repair owner.
  coordinator = new BotHandoffService(restarted);
  await coordinator.recover();
  await vi.waitFor(
    () =>
      expect(handoffs.getBotHandoffAssociation(linked.id)?.state).toBe(
        'associated',
      ),
    { timeout: 10000 },
  );
  // Native admission must settle even while the model and progress path remain
  // held. Status projection is not the authority for admission identity.
  expect(holdModel).toBe(true);
  expect(suppressProgress).toBe(true);
  expect(handoffs.getBotHandoff(linked.id)?.state).not.toBe('completed');
  suppressProgress = false;
  expect(store.listProductInputs(id)).toHaveLength(1);
  expect(store.listProductInputs(id)[0]).toMatchObject({
    id: original.id,
    request_id: original.request_id,
    payload_digest: original.payload_digest,
    submission_id: nativeId,
  });
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  const recovered = await nativeSnapshot();
  expect(recovered.inputs).toHaveLength(1);
  expect(recovered.inputs[0]).toMatchObject({
    id: linked.request_id,
    submission_id: nativeId,
  });
  expect(recovered.view.docs['pi.live']?.run?.taskId).toBe(taskId);
  holdModel = false;
  for (const response of [...held]) {
    held.delete(response);
    respond(response);
  }
  await vi.waitFor(
    () => expect(handoffs.getBotHandoff(linked.id)?.state).toBe('completed'),
    { timeout: 15000 },
  );
  const result = groups
    .getBotGroupSnapshot('alice', group.group_id)
    .messages.filter((row) => row.author_kind === 'bot');
  expect(result).toHaveLength(1);
  expect(result[0].content).toBe('ONE_ORIGINAL_CLOUD_HANDOFF_RESULT');
  expect(handoffs.getBotHandoff(linked.id)).toMatchObject({
    id: linked.id,
    session_id: id,
    request_id: linked.request_id,
    input_id: original.id,
    submission_id: nativeId,
  });
  expect(posts).toHaveLength(2);
  expect(
    fs.existsSync(path.join(root, 'db/durable-sessions', `${id}.sqlite`)),
  ).toBe(false);
});
