// Actual workerd <-> actual Node HTTP authority <-> actual HTTP Provider fixture.
// Model output and localhost service routing are simulated; no deployment occurs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { afterAll, expect, test, vi } from 'vitest';
import type { CloudBinding } from '../src/personal-agent/cloud-wire.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-product-http-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_SESSION_SECRET: 'cloud-product-cookie-signing-fixture',
}));
const db = await import('../src/db.js');
const store = await import('../src/personal-agent/product-runtime-store.js');
const config = await import('../src/runtime-config.js');
const models = await import('../src/personal-agent/product-model.js');
const runtime = await import('../src/personal-agent/product-runtime.js');
const host = await import('../src/host-execution-policy.js');
const wire = await import('../src/personal-agent/cloud-wire.js');
const routes = (await import('../src/routes/cloud-runtime.js')).default;
const auth = await import('../src/auth.js');
const web = await import('../src/web.js');
// Narrow boundary to the installed Miniflare public constructor/dispatch/dispose
// API. Root Typecheck intentionally requires no optional Workers installation.
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
const modelReleases: (() => void)[] = [];
afterAll(async () => {
  for (const release of modelReleases.splice(0)) release();
  host.endHostPrivilegeRevocation('alice');
  await worker?.dispose();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await runtime.getProductRuntimeService().close();
  vi.restoreAllMocks();
  db.closeDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
test('a registered product Cloud owner uses live Node policy/encrypted Provider, persists original tool input across workerd restart and refuses revoked resume', async () => {
  const bundle = path.resolve('apps/cloud-agent/dist/worker.js');
  expect(
    fs.existsSync(bundle),
    'Build the Cloud dry-run bundle before this integration suite',
  ).toBe(true);
  const secret = 'local-cross-runtime-control-fixture-key';
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
  db.setRegisteredGroup('web:alice', {
    name: 'Cloud bridge',
    folder: 'alice',
    created_by: 'alice',
    executionMode: 'host',
    added_at: now,
    is_home: false,
  });
  const nonce = randomUUID(),
    hash = createHash('sha256').update(nonce).digest('hex');
  const received: {
    authorization: string | undefined;
    messages: { role: string; content?: unknown }[];
  }[] = [];
  let holdModel = false;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as {
      messages: { role: string; content?: unknown }[];
    };
    received.push({
      authorization: request.headers.authorization,
      messages: input.messages,
    });
    if (holdModel)
      await new Promise<void>((resolve) => modelReleases.push(resolve));
    const hasTool = input.messages.some(
      (message) =>
        message.role === 'tool' &&
        JSON.stringify(message.content).includes(hash),
    );
    const delta = hasTool
      ? { role: 'assistant', content: 'CLOUD_PRODUCT_BRIDGE_VERIFIED' }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'actual-cloud-inspect',
              type: 'function',
              function: {
                name: 'inspect_text',
                arguments: JSON.stringify({ text: nonce }),
              },
            },
          ],
        };
    const packet = (value: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'http-fixture', object: 'chat.completion.chunk', created: 1, model: 'product-configured-model', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      packet(delta, null) +
        packet({}, hasTool ? 'stop' : 'tool_calls') +
        'data: [DONE]\n\n',
    );
  });
  provider.listen(0, '127.0.0.1');
  servers.push(provider);
  await once(provider, 'listening');
  const providerPort = (provider.address() as { port: number }).port;
  const p = config.createProvider({
    name: 'Cross-runtime local fixture',
    type: 'third_party',
    anthropicBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
    anthropicApiKey: 'synthetic-gateway-only-provider-key',
    anthropicModel: 'product-configured-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  });
  const authority = serve({
    fetch: (request) => routes.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
  }) as Server; // serve() uses HTTP/1 with these options.
  servers.push(authority);
  if (!authority.listening) await once(authority, 'listening');
  const authorityPort = (authority.address() as { port: number }).port;
  const selected = models.productModelConfiguration('web:alice', p.id),
    id = randomUUID();
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Cloud HTTP bridge',
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
        instructions:
          'Use inspect_text when asked. No other tools are authorized.',
        max_model_steps: 6,
        deadline_at: Date.now() + 60000,
      },
    },
  );
  const binding = JSON.parse(
    store.getCloudPlacement(id)!.binding_json,
  ) as CloudBinding;
  const authorityResponses: { operation: string; status: number }[] = [];
  const resultCommits = new Map<string, () => void>();
  let rejectResultOnce: { requestId: string; rejected: () => void } | undefined;
  let gapDelivery:
    | {
        requestId: string;
        reached: () => void;
        gate: Promise<void>;
        committed: (status: number) => void;
      }
    | undefined;
  let releaseGapDelivery: (() => void) | undefined;
  function start(admission: boolean) {
    // Explicit test-only host routing. Requests still cross a real HTTP server
    // and retain signed method/path/body; production requires trusted HTTPS.
    return new Miniflare(
      convertV4MiniflareOptions({
        name: 'miniclaw-cloud-agent',
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
            const requestBody = await request.text();
            const resultRequest = new URL(request.url).pathname.endsWith(
              '/results',
            )
              ? (JSON.parse(requestBody).input.request_id as string)
              : undefined;
            if (
              resultRequest &&
              rejectResultOnce?.requestId === resultRequest
            ) {
              const rejected = rejectResultOnce.rejected;
              rejectResultOnce = undefined;
              authorityResponses.push({ operation: 'results', status: 503 });
              rejected();
              return new Response(null, { status: 503 });
            }
            const isGapResult =
              gapDelivery &&
              new URL(request.url).pathname.endsWith('/results') &&
              JSON.parse(requestBody).input.request_id ===
                gapDelivery.requestId;
            if (isGapResult) {
              gapDelivery!.reached();
              await gapDelivery!.gate;
            }
            const response = await fetch(
              `http://127.0.0.1:${authorityPort}${new URL(request.url).pathname}`,
              {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                body: requestBody,
                redirect: 'error',
                signal: request.signal,
              },
            );
            authorityResponses.push({
              operation: new URL(request.url).pathname.split('/').at(-1)!,
              status: response.status,
            });
            if (isGapResult && response.ok)
              gapDelivery!.committed(response.status);
            if (resultRequest && response.ok)
              resultCommits.get(resultRequest)?.();
            return response;
          },
        },
      }),
    );
  }
  async function call(suffix = '', method = 'GET', body?: unknown) {
    const url = `https://cloud.fixture/internal/cloud-sessions${suffix === 'create' ? '' : `/${id}${suffix}`}`;
    const signed = await wire.signedRequest(
      secret,
      binding,
      url,
      method,
      body === undefined ? '' : JSON.stringify(body),
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
  const created = (await provision.json()) as {
    object_id: string;
    conversation_id: number;
    epoch: string;
  };
  expect(store.getCloudPlacement(id)?.object_id).toBe(created.object_id);
  store.bindProductConversation(id, created.conversation_id);
  const requestId = randomUUID();
  const receipt = store.admitProductInput(
    id,
    requestId,
    {
      content: 'inspect the authorized evidence',
      followUpBehavior: 'queue',
      sender: 'alice',
      senderName: 'Alice',
    },
    () => {},
  );
  const admitted = await call('/messages', 'POST', {
    request_id: requestId,
    content: 'inspect the authorized evidence',
    product_receipt_digest: receipt.payload_digest,
  });
  expect(admitted.status).toBe(202);
  const ack = (await admitted.json()) as {
    receipt: { operationId: string; accepted: boolean; submission_id: number };
  };
  expect(ack.receipt.operationId).toBe(requestId);
  expect(ack.receipt.accepted).toBe(true);
  expect(ack.receipt.submission_id).toBeGreaterThan(0);
  store.markProductInputSubmitted(receipt.id, ack.receipt.submission_id);

  let completed:
    | {
        epoch: string;
        object_id: string;
        inputs: {
          id: string;
          submission_id: number;
          status: string;
          answer_entry_id?: number;
        }[];
        view: { entries: unknown[] };
      }
    | undefined;
  await expect
    .poll(async () => {
      const response = await call();
      expect(response.status).toBe(200);
      completed = (await response.json()) as typeof completed;
      return completed!.inputs.find((input) => input.id === requestId)?.status;
    })
    .toBe('done');
  const nativeInput = completed!.inputs.find(
    (input) => input.id === requestId,
  )!;
  expect(nativeInput.submission_id).toBeGreaterThan(0);
  store.markProductInputSubmitted(receipt.id, nativeInput.submission_id);
  expect(received).toHaveLength(2);
  expect(
    received.every(
      (input) =>
        input.authorization === 'Bearer synthetic-gateway-only-provider-key',
    ),
  ).toBe(true);
  expect(JSON.stringify(received[1].messages)).toContain(hash);
  expect(JSON.stringify(completed!.view.entries)).toContain(
    'CLOUD_PRODUCT_BRIDGE_VERIFIED',
  );
  expect(JSON.stringify(completed)).not.toContain(
    'synthetic-gateway-only-provider-key',
  );
  const original = completed!;
  await worker.dispose();
  worker = start(false);
  const recoveredResponse = await call();
  expect(recoveredResponse.status).toBe(200);
  const recovered = (await recoveredResponse.json()) as typeof original;
  expect(recovered.epoch).not.toBe(original.epoch);
  expect(recovered.object_id).toBe(created.object_id);
  expect(recovered.inputs).toEqual(original.inputs);
  expect(recovered.view.entries).toEqual(original.view.entries);
  expect(received).toHaveLength(2);
  expect(store.productRouterKind(id)).toBe('cloudflare-durable');
  expect(store.getCloudPlacement(id)?.model_attempts).toBe(2);
  expect(
    fs.existsSync(path.join(root, 'db/durable-sessions', id + '.sqlite')),
  ).toBe(false);
  host.beginHostPrivilegeRevocation('alice');
  const liveDenied = await call();
  expect(liveDenied.status).toBe(409);
  await liveDenied.body?.cancel();
  host.endHostPrivilegeRevocation('alice');
  // A product-store restore that loses the original intent must never cause
  // the native input to be placed again under a new request ID.
  await worker.dispose();
  const originalInput = store.listProductInputs(id)[0];
  const raw = new Database(path.join(root, 'db/messages.db'));
  raw
    .prepare('DELETE FROM product_session_inputs WHERE id=?')
    .run(originalInput.id);
  worker = start(false);
  const orphan = await call();
  expect(orphan.status).toBe(409);
  await orphan.body?.cancel();
  expect(received).toHaveLength(2);
  await worker.dispose();
  const fields = Object.keys(originalInput);
  raw
    .prepare(
      `INSERT INTO product_session_inputs(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
    )
    .run(...Object.values(originalInput));
  raw.close();
  host.beginHostPrivilegeRevocation('alice');
  worker = start(false);
  const denied = await call();
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({ error: 'CLOUD_EXECUTION_SUSPENDED' });
  expect(received).toHaveLength(2);

  // Formal product routes, real signed Cookie auth and existing Session store.
  // Only the HTTPS hostname-to-local-workerd transport is remapped by this test.
  host.endHostPrivilegeRevocation('alice');
  await worker.dispose();
  worker = start(true);
  config.setDefaultProvider(p.id);
  vi.stubEnv('MINICLAW_CLOUD_RUNTIME', 'true');
  vi.stubEnv('MINICLAW_CLOUD_ORIGIN', 'https://cloud.fixture');
  const app = web.createAppForTest(
    {} as Parameters<typeof web.createAppForTest>[0],
  );
  function clientCookie() {
    const token = auth.generateSessionToken();
    db.createUserSession({
      id: token,
      user_id: 'alice',
      ip_address: null,
      user_agent: null,
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    return `miniclaw_session=${auth.signSessionToken(token)}`;
  }
  const desktopCookie = clientCookie(),
    mobileCookie = clientCookie();
  async function product(
    pathname: string,
    method = 'GET',
    body?: unknown,
    cookie = desktopCookie,
  ) {
    return app.request(pathname, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  let loseInputReceipt = true;
  let loseControlReceipt = false;
  let cloudCalls = 0;
  const originalFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== 'https://cloud.fixture')
      return originalFetch(input, init);
    cloudCalls++;
    const response = await worker!.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.method === 'GET' ? undefined : await request.text(),
    });
    if (loseInputReceipt && request.url.endsWith('/messages') && response.ok) {
      loseInputReceipt = false;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    if (
      loseControlReceipt &&
      request.url.endsWith('/controls') &&
      response.ok
    ) {
      loseControlReceipt = false;
      await response.body?.cancel();
      return new Response(null, { status: 503 });
    }
    return response;
  });
  const creationKey = randomUUID();
  const createBody = {
    name: 'Formal Cloud Session',
    description: 'Test explicit product routing',
    runtime: 'cloudflare-durable',
    requestId: creationKey,
  };
  const createdProduct = await product(
    '/api/groups/web:alice/sessions',
    'POST',
    createBody,
  );
  expect(createdProduct.status).toBe(200);
  const formal = (await createdProduct.json()) as {
    session: { id: string; runtime_router: string };
  };
  expect(formal.session.runtime_router).toBe('cloudflare-durable');
  const formalId = formal.session.id;
  const placement = store.getCloudPlacement(formalId)!;
  expect(placement).toBeDefined();
  vi.stubEnv('MINICLAW_CLOUD_RUNTIME', 'false');
  const retryCreation = await product(
    '/api/groups/web:alice/sessions',
    'POST',
    createBody,
    mobileCookie,
  );
  expect(retryCreation.status).toBe(200);
  expect(((await retryCreation.json()) as typeof formal).session.id).toBe(
    formalId,
  );
  const changedRuntime = await product(
    '/api/groups/web:alice/sessions',
    'POST',
    { ...createBody, runtime: 'local-pi' },
  );
  expect(changedRuntime.status).toBe(409);
  const deniedCreation = await product(
    '/api/groups/web:alice/sessions',
    'POST',
    { ...createBody, requestId: randomUUID() },
  );
  expect(deniedCreation.status).toBe(409);

  const messageBody = {
    chatJid: 'web:alice',
    agentId: formalId,
    content: 'inspect formal product evidence',
    followUpBehavior: 'queue',
    requestId: randomUUID(),
  };
  const lostAck = await product('/api/messages', 'POST', messageBody);
  expect(lostAck.status).toBe(409);
  expect(loseInputReceipt).toBe(false);
  const originalProductInput = store.listProductInputs(formalId)[0];
  expect(originalProductInput).toBeDefined();
  // No Session snapshot, SSE subscription, browser or Node monitor is attached.
  // The DO outbox must finish the original product input and persist its answer.
  await expect
    .poll(() => store.listProductInputs(formalId)[0]?.state)
    .toBe('completed');
  const stableReceipt = store.listProductInputs(formalId)[0];
  expect(stableReceipt.id).toBe(originalProductInput.id);
  expect(stableReceipt.submission_id).toBeGreaterThan(0);
  expect(
    db.getMessageText(
      `web:alice#agent:${formalId}`,
      store.productAnswerMessageId(stableReceipt.id),
    ),
  ).toBe('CLOUD_PRODUCT_BRIDGE_VERIFIED');
  expect(db.getAgent(formalId)?.status).toBe('idle');
  const modelCount = received.length;
  const retryMessage = await product(
    '/api/messages',
    'POST',
    messageBody,
    mobileCookie,
  );
  expect(retryMessage.status).toBe(200);
  expect(
    ((await retryMessage.json()) as { submissionId: number }).submissionId,
  ).toBe(stableReceipt.submission_id);
  expect(store.listProductInputs(formalId)).toHaveLength(1);
  expect(received).toHaveLength(modelCount);
  const runtimePath = `/api/groups/web:alice/sessions/${formalId}/runtime`;
  const desktop = await product(runtimePath),
    mobile = await product(runtimePath, 'GET', undefined, mobileCookie);
  expect(desktop.status).toBe(200);
  expect(mobile.status).toBe(200);
  const desktopState = (await desktop.json()) as Record<string, unknown>;
  expect(await mobile.json()).toEqual(desktopState);
  expect(desktopState.runtimeKind).toBe('cloudflare-durable');
  expect(
    fs.existsSync(path.join(root, 'db/durable-sessions', formalId + '.sqlite')),
  ).toBe(false);
  await worker.dispose();
  worker = start(false);
  const afterRestart = await product(
    runtimePath,
    'GET',
    undefined,
    mobileCookie,
  );
  expect(afterRestart.status).toBe(200);
  expect(
    ((await afterRestart.json()) as { inputs: { submission_id: number }[] })
      .inputs[0].submission_id,
  ).toBe(stableReceipt.submission_id);
  expect(received).toHaveLength(modelCount);
  // A held real HTTP provider keeps a run active while two product clients
  // manipulate the same native Inbox. Model answers remain simulated.
  holdModel = true;
  const activeBody = {
    ...messageBody,
    content: 'controlled active run',
    requestId: randomUUID(),
  };
  const active = await product('/api/messages', 'POST', activeBody);
  expect(active.status).toBe(200);
  await active.json();
  await expect.poll(() => received.length).toBe(modelCount + 1);
  const queuedBody = {
    ...messageBody,
    content: 'original queued bytes',
    requestId: randomUUID(),
  };
  const queued = await product(
    '/api/messages',
    'POST',
    queuedBody,
    mobileCookie,
  );
  expect(queued.status).toBe(200);
  const queuedId = ((await queued.json()) as { submissionId: number })
    .submissionId;
  const otherBody = {
    ...messageBody,
    content: 'queue to cancel',
    requestId: randomUUID(),
  };
  const other = await product('/api/messages', 'POST', otherBody);
  expect(other.status).toBe(200);
  const otherId = ((await other.json()) as { submissionId: number })
    .submissionId;
  async function state() {
    const response = await product(runtimePath, 'GET', undefined, mobileCookie);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      live: {
        taskId: number;
        queueDigest: string;
        queue: { submissionId: number; content: string; mode: string }[];
      };
    };
  }
  async function control(command: Record<string, unknown>, key = randomUUID()) {
    return product(
      `/api/groups/web:alice/sessions/${formalId}/controls`,
      'POST',
      { requestId: key, command },
      mobileCookie,
    );
  }
  const initial = await state();
  expect(initial.live.queue.map((row) => row.content)).toEqual([
    'original queued bytes',
    'queue to cancel',
  ]);
  const edit = {
    action: 'edit',
    submissionId: queuedId,
    expectedQueueDigest: initial.live.queueDigest,
    content: 'edited authorized bytes',
  };
  const editKey = randomUUID();
  loseControlReceipt = true;
  expect((await control(edit, editKey)).status).toBe(409);
  expect(loseControlReceipt).toBe(false);
  // Cold recovery must retain the committed edit when its product ACK was lost.
  await worker.dispose();
  worker = start(false);
  expect((await state()).live.queue[0].content).toBe('edited authorized bytes');
  const editRetry = await control(edit, editKey);
  expect(editRetry.status).toBe(200);
  expect(
    ((await editRetry.json()) as { control: { state: string } }).control.state,
  ).toBe('applied');
  expect(
    (await control({ ...edit, content: 'changed retry payload' }, editKey))
      .status,
  ).toBe(409);
  const reorder = await control({
    action: 'reorder',
    submissionIds: [otherId, queuedId],
    expectedQueueDigest: (await state()).live.queueDigest,
  });
  expect(reorder.status).toBe(200);
  await reorder.json();
  expect((await state()).live.queue.map((row) => row.submissionId)).toEqual([
    otherId,
    queuedId,
  ]);
  const steer = await control({
    action: 'steer',
    submissionId: otherId,
    expectedQueueDigest: (await state()).live.queueDigest,
  });
  expect(steer.status).toBe(200);
  await steer.json();
  expect((await state()).live.queue[0].mode).toBe('steer');
  const cancel = await control({
    action: 'cancel',
    submissionId: otherId,
    expectedQueueDigest: (await state()).live.queueDigest,
  });
  expect(cancel.status).toBe(200);
  await cancel.json();
  const beforeAbort = await state();
  expect(beforeAbort.live.queue.map((row) => row.submissionId)).toEqual([
    queuedId,
  ]);
  const abort = {
    action: 'abort',
    taskId: beforeAbort.live.taskId,
    expectedQueueDigest: beforeAbort.live.queueDigest,
  };
  const abortKey = randomUUID();
  const stopped = await control(abort, abortKey);
  expect(stopped.status).toBe(200);
  await stopped.json();
  // Pi 1.3.0 abort leaves unrelated follow-ups queued. A new explicit user
  // instruction advances that original Inbox; no old prompt is manufactured.
  expect((await state()).live.queue.map((row) => row.submissionId)).toEqual([
    queuedId,
  ]);
  const continuationRequest = randomUUID();
  const continuationCommitted = new Promise<void>((resolve) => {
    resultCommits.set(continuationRequest, resolve);
  });
  const resultRejected = new Promise<void>((resolve) => {
    rejectResultOnce = { requestId: continuationRequest, rejected: resolve };
  });
  const continued = await product('/api/messages', 'POST', {
    ...messageBody,
    content: 'Continue the preserved queue',
    requestId: continuationRequest,
  });
  expect(continued.status).toBe(200);
  await continued.json();
  // Retrying the old exact-task abort must not stop the new generation.
  expect((await control(abort, abortKey)).status).toBe(200);
  holdModel = false;
  for (const release of modelReleases.splice(0)) release();
  try {
    // Admission is not a result commit. Force one real outbox failure, verify
    // the original input stays pending, then await its actual Node HTTP commit.
    // The persisted retry backoff exceeds expect.poll's implicit one second;
    // this barrier retains the suite deadline and all original state assertions.
    await resultRejected;
    expect(
      store
        .listProductInputs(formalId)
        .find((row) => row.request_id === continuationRequest)?.state,
    ).toBe('submitted');
    await continuationCommitted;
    resultCommits.delete(continuationRequest);
    await expect
      .poll(() =>
        store
          .listProductInputs(formalId)
          .filter((row) => !['completed', 'failed'].includes(row.state))
          .map((row) => ({
            state: row.state,
            submission_id: row.submission_id,
          })),
      )
      .toEqual([]);
  } catch (error) {
    const b = JSON.parse(
      store.getCloudPlacement(formalId)!.binding_json,
    ) as CloudBinding;
    const signed = await wire.signedRequest(
      secret,
      b,
      `https://cloud.fixture/internal/cloud-sessions/${formalId}`,
      'GET',
    );
    const diagnostic = await worker!.dispatchFetch(signed.url, {
      headers: Object.fromEntries(signed.headers),
    });
    const snapshot = (await diagnostic.json()) as Record<string, unknown>;
    throw new Error(
      JSON.stringify({
        inputs: snapshot.inputs,
        deliveries: snapshot.deliveries,
        controls: snapshot.controls,
        product_inputs: store.listProductInputs(formalId).map((row) => ({
          request_id: row.request_id,
          submission_id: row.submission_id,
          state: row.state,
        })),
        authority: authorityResponses
          .filter((row) => row.status !== 200)
          .slice(-10),
      }),
      { cause: error },
    );
  }
  const controlled = store.listProductInputs(formalId);
  expect(
    controlled.find((row) => row.request_id === activeBody.requestId)?.state,
  ).toBe('failed');
  expect(
    controlled.find((row) => row.request_id === queuedBody.requestId)?.state,
  ).toBe('completed');
  expect(
    controlled.find((row) => row.request_id === otherBody.requestId)?.state,
  ).toBe('failed');
  expect(
    db.getMessageText(
      `web:alice#agent:${formalId}`,
      controlled.find((row) => row.request_id === queuedBody.requestId)!.id,
    ),
  ).toBe('edited authorized bytes');
  const afterControls = received.length;
  await worker.dispose();
  worker = start(false);
  expect((await product(runtimePath)).status).toBe(200);
  expect(received).toHaveLength(afterControls);
  // A true product admission gap: durable Node input/message, no DO receipt.
  // Startup must not call back through an HTTP server that is not listening.
  const gapRequest = randomUUID();
  modelReleases.push(() => releaseGapDelivery?.());
  let reached!: () => void, committed!: (status: number) => void;
  const resultReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resultCommitted = new Promise<number>((resolve) => {
    committed = resolve;
  });
  gapDelivery = {
    requestId: gapRequest,
    reached,
    committed,
    gate: new Promise<void>((resolve) => {
      releaseGapDelivery = resolve;
    }),
  };
  const gap = store.admitProductInput(
    formalId,
    gapRequest,
    {
      content: 'Recover the original broker handoff',
      followUpBehavior: 'queue',
      sender: 'alice',
      senderName: 'Alice',
    },
    (row) =>
      db.storeMessageDirect(
        row.id,
        `web:alice#agent:${formalId}`,
        'alice',
        'Alice',
        'Recover the original broker handoff',
        row.created_at,
        false,
      ),
  );
  await runtime.getProductRuntimeService().close();
  const restartedService = runtime.startProductRuntimeService();
  const beforeReady = cloudCalls;
  await restartedService.recover();
  expect(cloudCalls).toBe(beforeReady);
  expect(
    store.listProductInputs(formalId).find((row) => row.id === gap.id)
      ?.submission_id,
  ).toBeNull();
  await restartedService.recoverCloudHandoffs();
  // Handoff recovery acknowledges admission, not asynchronous execution/result
  // delivery. Hold the actual result callback to prove that distinction, then
  // await its real Node HTTP commit instead of expect.poll's implicit 1s limit.
  // The suite's existing overall deadline remains unchanged.
  await resultReached;
  expect(
    store.listProductInputs(formalId).find((row) => row.id === gap.id),
  ).toMatchObject({
    state: 'submitted',
    id: gap.id,
    request_id: gapRequest,
  });
  releaseGapDelivery!();
  expect(await resultCommitted).toBe(200);
  expect(
    store.listProductInputs(formalId).find((row) => row.id === gap.id)?.state,
  ).toBe('completed');
  const recoveredGap = store
    .listProductInputs(formalId)
    .filter((row) => row.request_id === gapRequest);
  expect(recoveredGap).toHaveLength(1);
  expect(recoveredGap[0].id).toBe(gap.id);
  expect(recoveredGap[0].submission_id).toBeGreaterThan(0);
  expect(
    fs.existsSync(path.join(root, 'db/durable-sessions', formalId + '.sqlite')),
  ).toBe(false);
});
