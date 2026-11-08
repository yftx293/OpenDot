// Real product SQLite/encrypted Provider authority and real HTTP transport.
// Deterministic local SSE is simulated model output, not vendor acceptance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  CloudBinding,
  CloudToolCapability,
} from '../src/personal-agent/cloud-wire.js';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-product-authority-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const store = await import('../src/personal-agent/product-runtime-store.js');
const model = await import('../src/personal-agent/product-model.js');
const config = await import('../src/runtime-config.js');
const host = await import('../src/host-execution-policy.js');
const runtime = await import('../src/personal-agent/product-runtime.js');
const wire = await import('../src/personal-agent/cloud-wire.js');
const routes = (await import('../src/routes/cloud-runtime.js')).default;
const personalMemory =
  await import('../src/personal-agent/personal-memory-store.js');
// Load the real Web broadcasters before the bounded fixture hook; cold module
// construction is preparation, not a cloud-authority business assertion.
await import('../src/web.js');
const secret = 'local-product-cloud-control-fixture-key';
let calls = 0,
  hold = false,
  fail = false,
  partial = false,
  doneWithoutFinish = false,
  oversized = false,
  providerId = '';
const held = new Set<ServerResponse>();
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  calls++;
  expect(request.url).toBe('/v1/chat/completions');
  expect(request.headers.authorization).toBe(
    'Bearer synthetic-product-provider-key',
  );
  expect(JSON.parse(body).model).toBe('product-configured-model');
  if (hold) {
    held.add(response);
    response.on('close', () => held.delete(response));
    return;
  }
  if (fail) {
    response.writeHead(504);
    response.end('synthetic-product-provider-key must not reach client');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (partial) {
    response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    return;
  }
  if (doneWithoutFinish) {
    response.end(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    );
    return;
  }
  if (oversized) {
    response.end(
      'data: ' + 'x'.repeat(4 * 1024 * 1024 + 1) + '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  response.end(
    'data: {"model":"product-configured-model","choices":[{"delta":{"content":"PRODUCT_AUTHORITY_FIXTURE"},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n',
  );
});
beforeAll(async () => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['alice', 'bob']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'fixture',
      display_name: id,
      role: 'admin',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    db.setRegisteredGroup(`web:${id}`, {
      name: id,
      folder: id,
      created_by: id,
      executionMode: 'host',
      added_at: now,
      is_home: false,
    });
  }
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address() as { port: number };
  providerId = config.createProvider({
    name: 'Actual local HTTP fixture',
    type: 'third_party',
    anthropicBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    anthropicApiKey: 'synthetic-product-provider-key',
    anthropicModel: 'product-configured-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  }).id;
  runtime.startProductRuntimeService();
});
afterEach(() => {
  vi.unstubAllEnvs();
  hold = false;
  fail = false;
  partial = false;
  doneWithoutFinish = false;
  oversized = false;
  host.endHostPrivilegeRevocation('alice');
});
afterAll(async () => {
  for (const response of held) response.destroy();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await runtime.getProductRuntimeService().close();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
function session(
  cloud = true,
  max = 6,
  prebound = true,
  capabilities?: CloudToolCapability[],
) {
  const selected = model.productModelConfiguration('web:alice', providerId);
  const id = randomUUID(),
    now = new Date().toISOString();
  db.createAgent(
    {
      id,
      chat_jid: 'web:alice',
      group_folder: 'alice',
      name: 'Cloud placement',
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
      providerId,
      configFingerprint: selected.fingerprint,
      ...(cloud
        ? {
            cloud: {
              runtime_id: randomUUID(),
              gateway_origin: 'https://cloud.fixture',
              model_id: selected.modelId,
              instructions: 'Only inspect_text is available.',
              max_model_steps: max,
              deadline_at: Date.now() + 60000,
              ...(capabilities !== undefined
                ? { tool_capabilities: capabilities }
                : {}),
            },
          }
        : {}),
    },
  );
  if (cloud && prebound) {
    store.bindCloudObject(
      id,
      store.getCloudPlacement(id)!.runtime_id,
      'a'.repeat(64),
    );
    store.bindProductConversation(id, 1);
  }
  return id;
}
function binding(id: string) {
  return JSON.parse(store.getCloudPlacement(id)!.binding_json) as CloudBinding;
}
async function call(
  b: CloudBinding,
  suffix: string,
  input: unknown,
  requestId?: string,
) {
  vi.stubEnv('MINICLAW_CLOUD_SHARED_SECRET', secret);
  const path = `/api/cloud-runtime/${b.session_id}/objects/${'a'.repeat(64)}/${suffix}${requestId ? '/' + requestId : ''}`;
  return routes.fetch(
    await wire.signedRequest(
      secret,
      b,
      'https://product.fixture' + path,
      'POST',
      JSON.stringify(input),
    ),
  );
}
const input = {
  model: 'product-configured-model',
  stream: true,
  messages: [{ role: 'user', content: 'fixture' }],
  max_tokens: 128,
};
function rawDb() {
  return new Database(path.join(root, 'db/messages.db'));
}
test('persists Cloud owner in the existing product transaction, leaves old Sessions on Node and refuses Node activation', async () => {
  const node = session(false),
    cloud = session(true, 6, false);
  expect(store.productRouterKind(node)).toBe('node-durable');
  expect(store.productRouterKind(cloud)).toBe('cloudflare-durable');
  const original = binding(cloud);
  vi.stubEnv('MINICLAW_CLOUD_RUNTIME', 'false');
  db.closeDatabase();
  db.initDatabase();
  expect(binding(cloud)).toEqual(original);
  const service = runtime.getProductRuntimeService();
  await expect(
    service.submit(cloud, randomUUID(), {
      content: 'must not run locally',
      followUpBehavior: 'queue',
      sender: 'alice',
      senderName: 'Alice',
    }),
  ).rejects.toThrow('CLOUD_BINDING_UNAVAILABLE');
  expect(store.listProductInputs(cloud)).toHaveLength(0);
  expect(
    fs.existsSync(path.join(root, 'db/durable-sessions', cloud + '.sqlite')),
  ).toBe(false);
  expect(store.getProductRuntime(cloud)?.state).toBe('provisioning');
  const raw = rawDb();
  try {
    expect(() =>
      raw
        .prepare(
          "UPDATE product_cloud_sessions SET gateway_origin='https://other.fixture' WHERE session_id=?",
        )
        .run(cloud),
    ).toThrow();
    store.bindCloudObject(cloud, original.runtime_id, 'a'.repeat(64));
    store.bindCloudObject(cloud, original.runtime_id, 'a'.repeat(64));
    expect(() => store.bindProductConversation(cloud, 9)).toThrow('Cloud root');
    expect(() =>
      raw
        .prepare(
          'UPDATE product_session_runtimes SET conversation_id=9 WHERE session_id=?',
        )
        .run(cloud),
    ).toThrow('Cloud root');
    store.bindProductConversation(cloud, 1);
    expect(() =>
      store.bindCloudObject(cloud, original.runtime_id, 'b'.repeat(64)),
    ).toThrow();
    store.bindProductConversation(node, 9);
    expect(() =>
      raw
        .prepare(
          'INSERT INTO product_cloud_sessions(session_id,runtime_id,gateway_origin,binding_json,created_at) VALUES(?,?,?,?,?)',
        )
        .run(
          node,
          randomUUID(),
          'https://cloud.fixture',
          JSON.stringify({ ...original, session_id: node }),
          new Date().toISOString(),
        ),
    ).toThrow();
  } finally {
    raw.close();
  }
});
test('private policy requires signed exact scope and binding; Cookie, tampering and cross-owner requests fail', async () => {
  const b = binding(session());
  const body = {
    binding_digest: await wire.bindingDigest(b),
    gateway_origin: 'https://cloud.fixture',
  };
  expect((await call(b, 'policy', body)).status).toBe(200);
  expect(
    (
      await routes.request(
        `https://product.fixture/api/cloud-runtime/${b.session_id}/objects/${'a'.repeat(64)}/policy`,
        {
          method: 'POST',
          headers: { cookie: 'miniclaw_session=fixture' },
          body: JSON.stringify(body),
        },
      )
    ).status,
  ).toBe(401);
  expect(
    (await call({ ...b, owner_user_id: 'bob' }, 'policy', body)).status,
  ).toBe(404);
  expect(
    (await call({ ...b, runtime_id: randomUUID() }, 'policy', body)).status,
  ).toBe(404);
  expect(
    (
      await call(b, 'policy', {
        binding_digest: '0'.repeat(64),
        gateway_origin: 'https://cloud.fixture',
      })
    ).status,
  ).toBe(409);
  const signed = await wire.signedRequest(
    secret,
    b,
    `https://product.fixture/api/cloud-runtime/${b.session_id}/objects/${'a'.repeat(64)}/policy`,
    'POST',
    JSON.stringify(body),
  );
  const changed = new Request(signed, {
    body: JSON.stringify({ binding_digest: '1'.repeat(64) }),
  });
  expect((await routes.fetch(changed)).status).toBe(401);
});
test('actual encrypted Provider proxy returns SSE without key; duplicate attempt ID and unknown fields never call provider again', async () => {
  const b = binding(session());
  const before = calls,
    id = randomUUID();
  const response = await call(b, 'model', input, id);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('PRODUCT_AUTHORITY_FIXTURE');
  expect(text).not.toContain('synthetic-product-provider-key');
  expect((await call(b, 'model', input, id)).status).toBe(409);
  expect(
    (await call(b, 'model', { ...input, model: 'other' }, randomUUID())).status,
  ).toBe(409);
  expect(
    (await call(b, 'model', { ...input, web_search_options: {} }, randomUUID()))
      .status,
  ).toBe(400);
  expect(calls).toBe(before + 1);
  const raw = rawDb();
  try {
    expect(
      raw
        .prepare(
          'SELECT state FROM product_cloud_model_attempts WHERE session_id=? AND request_id=?',
        )
        .get(b.session_id, id),
    ).toEqual({ state: 'completed' });
  } finally {
    raw.close();
  }
});
test('Workspace/Host revocation fences new policy and model requests without outbound credentials', async () => {
  const b = binding(session()),
    before = calls;
  host.beginHostPrivilegeRevocation('alice');
  expect(
    (
      await call(b, 'policy', {
        binding_digest: await wire.bindingDigest(b),
        gateway_origin: 'https://cloud.fixture',
      })
    ).status,
  ).toBe(404);
  expect((await call(b, 'model', input, randomUUID())).status).toBe(404);
  host.endHostPrivilegeRevocation('alice');
  const raw = rawDb();
  try {
    raw
      .prepare(
        "UPDATE registered_groups SET created_by='bob' WHERE jid='web:alice'",
      )
      .run();
    expect((await call(b, 'model', input, randomUUID())).status).toBe(404);
  } finally {
    raw
      .prepare(
        "UPDATE registered_groups SET created_by='alice' WHERE jid='web:alice'",
      )
      .run();
    raw.close();
  }
  expect(calls).toBe(before);
});
test('revoking a live Host owner aborts an actual held HTTP model connection and preserves an uncertain receipt', async () => {
  const b = binding(session()),
    id = randomUUID();
  hold = true;
  const before = calls;
  const pending = call(b, 'model', input, id);
  await expect.poll(() => calls).toBe(before + 1);
  host.beginHostPrivilegeRevocation('alice');
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic-product-provider-key');
  await expect.poll(() => held.size).toBe(0);
  const raw = rawDb();
  try {
    expect(
      raw
        .prepare(
          'SELECT state FROM product_cloud_model_attempts WHERE session_id=? AND request_id=?',
        )
        .get(b.session_id, id),
    ).toEqual({ state: 'uncertain' });
  } finally {
    raw.close();
  }
});
test('attempt budget persists across database reopen; upstream timeouts remain uncertain and do not expose their body', async () => {
  const b = binding(session(true, 1)),
    id = randomUUID(),
    before = calls;
  fail = true;
  const failed = await call(b, 'model', input, id);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('synthetic-product-provider-key');
  db.closeDatabase();
  db.initDatabase();
  expect((await call(b, 'model', input, randomUUID())).status).toBe(409);
  expect(calls).toBe(before + 1);
  expect(store.getCloudPlacement(b.session_id)?.model_attempts).toBe(1);
});
test('v77 upgrade preserves original product identity and native memory in a private verified backup without cloud adoption', async () => {
  const id = session(false);
  const service = await import('../src/memory-service.js');
  const saved = service.createWorkspaceMemory({
    actor: { id: 'alice', role: 'admin' },
    workspaceJid: 'web:alice',
    sourceType: 'web_user',
    kind: 'fact',
    content: 'CLOUD_MIGRATION_FACT',
    idempotencyKey: randomUUID(),
  });
  db.closeDatabase();
  const raw = rawDb();
  // Historical v77 never had Cloud Sessions. Remove only this suite's internal
  // Cloud fixtures before representing the old schema; retain all Node data.
  raw.pragma('foreign_keys=ON');
  raw.exec(
    'DELETE FROM agents WHERE id IN (SELECT session_id FROM product_cloud_sessions)',
  );
  expect(
    raw.prepare('SELECT count(*) AS n FROM product_cloud_sessions').get(),
  ).toEqual({ n: 0 });
  raw.exec(
    "DROP TRIGGER product_cloud_root_binding;DROP TABLE product_cloud_execution_attempts;DROP TABLE product_cloud_executions;DROP TABLE product_cloud_model_attempts;DROP TABLE product_cloud_sessions;UPDATE router_state SET value='77' WHERE key='schema_version'",
  );
  raw.close();
  db.initDatabase();
  expect(db.getRouterState('schema_version')).toBe(
    String(db.CURRENT_SCHEMA_VERSION),
  );
  expect(store.productRouterKind(id)).toBe('node-durable');
  expect(store.getCloudPlacement(id)).toBeUndefined();
  const files = fs.readdirSync(path.join(root, 'db/migration-backups'));
  const name = files.find((n) =>
    n.startsWith(`messages-v77-to-v${db.CURRENT_SCHEMA_VERSION}-`),
  )!;
  const file = path.join(root, 'db/migration-backups', name);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const backup = new Database(file, { readonly: true });
  try {
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      backup
        .prepare(
          'SELECT session_id FROM product_session_runtimes WHERE session_id=?',
        )
        .get(id),
    ).toEqual({ session_id: id });
    expect(
      backup
        .prepare('SELECT content FROM workspace_memory_items WHERE id=?')
        .get(saved.item.id),
    ).toEqual({ content: 'CLOUD_MIGRATION_FACT' });
    expect(
      backup
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='product_cloud_sessions'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    backup.close();
  }
});

test('first authorized object bind is recoverable and a competing namespace cannot obtain execution authority', async () => {
  const id = session(true, 6, false),
    b = binding(id);
  const before = calls;
  expect((await call(b, 'model', input, randomUUID())).status).toBe(404);
  const policy = {
    binding_digest: await wire.bindingDigest(b),
    gateway_origin: 'https://cloud.fixture',
  };
  expect(
    (
      await call(b, 'policy', {
        ...policy,
        gateway_origin: 'https://other.fixture',
      })
    ).status,
  ).toBe(409);
  expect(store.getCloudPlacement(id)?.object_id).toBeNull();
  const first = await call(b, 'policy', policy);
  expect(first.status).toBe(200);
  await first.body?.cancel();
  expect((await call(b, 'policy', policy)).status).toBe(200);
  expect((await call(b, 'model', input, randomUUID())).status).toBe(409);
  expect(store.getCloudPlacement(id)?.model_attempts).toBe(0);
  store.bindProductConversation(id, 1);
  const url = `https://product.fixture/api/cloud-runtime/${id}/objects/${'b'.repeat(64)}/policy`;
  const competing = await routes.fetch(
    await wire.signedRequest(secret, b, url, 'POST', JSON.stringify(policy)),
  );
  expect(competing.status).toBe(404);
  expect(store.getCloudPlacement(id)?.object_id).toBe('a'.repeat(64));
  expect(calls).toBe(before);
});

test('partial EOF remains uncertain and an oversized real HTTP stream is cut off', async () => {
  const b = binding(session()),
    partialId = randomUUID(),
    missingFinishId = randomUUID(),
    largeId = randomUUID();
  partial = true;
  const response = await call(b, 'model', input, partialId);
  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow('CLOUD_MODEL_INTERRUPTED');
  partial = false;
  doneWithoutFinish = true;
  const incomplete = await call(b, 'model', input, missingFinishId);
  expect(incomplete.status).toBe(200);
  await expect(incomplete.text()).rejects.toThrow('CLOUD_MODEL_INTERRUPTED');
  doneWithoutFinish = false;
  oversized = true;
  const large = await call(b, 'model', input, largeId);
  expect(large.status).toBe(200);
  await expect(large.text()).rejects.toThrow('CLOUD_MODEL_INTERRUPTED');
  const raw = rawDb();
  try {
    expect(
      raw
        .prepare(
          'SELECT state FROM product_cloud_model_attempts WHERE session_id=? ORDER BY created_at,request_id',
        )
        .all(b.session_id),
    ).toEqual([
      { state: 'uncertain' },
      { state: 'uncertain' },
      { state: 'uncertain' },
    ]);
  } finally {
    raw.close();
  }
});
test('invalid Cloud selection rolls back the actual Session creation transaction', () => {
  const node = session(false),
    template = db.getAgent(node)!;
  const selected = model.productModelConfiguration('web:alice', providerId);
  const id = randomUUID();
  expect(() =>
    db.createAgent(
      { ...template, id },
      {
        kind: 'pi-durable',
        providerId,
        configFingerprint: selected.fingerprint,
        cloud: {
          runtime_id: randomUUID(),
          gateway_origin: 'http://untrusted.fixture',
          model_id: selected.modelId,
          instructions: '',
          max_model_steps: 2,
          deadline_at: Date.now() + 60000,
        },
      },
    ),
  ).toThrow('Cloud runtime placement');
  expect(db.getAgent(id)).toBeUndefined();
  expect(store.getProductRuntime(id)).toBeUndefined();
  expect(store.getCloudPlacement(id)).toBeUndefined();
});

test('product input authority binds the full original receipt and fences product acknowledgments ahead of native checkpoints', async () => {
  const b = binding(session()),
    requestId = randomUUID(),
    before = calls;
  const payload = {
    content: 'Original authorized task',
    followUpBehavior: 'queue' as const,
    sender: 'alice',
    senderName: 'Alice',
    origin: { messageId: 'original-product-message', sourceJid: 'web:alice' },
  };
  const row = store.admitProductInput(
    b.session_id,
    requestId,
    payload,
    () => {},
  );
  const proof = {
    input: {
      request_id: requestId,
      content: payload.content,
      when_busy: 'followUp',
      product_receipt_digest: row.payload_digest,
    },
    native: { submission_id: null as number | null, status: 'missing' },
  };
  expect((await call(b, 'inputs', proof)).status).toBe(200);
  expect(
    (
      await call(b, 'inputs', {
        ...proof,
        input: { ...proof.input, request_id: randomUUID() },
      })
    ).status,
  ).toBe(409);
  for (const changed of [
    { content: 'Changed task' },
    { when_busy: 'steer' },
    { product_receipt_digest: '0'.repeat(64) },
  ])
    expect(
      (
        await call(b, 'inputs', {
          ...proof,
          input: { ...proof.input, ...changed },
        })
      ).status,
    ).toBe(409);
  store.markProductInputSubmitted(row.id, 42);
  expect((await call(b, 'inputs', proof)).status).toBe(409);
  expect(
    (
      await call(b, 'inputs', {
        ...proof,
        native: { submission_id: 41, status: 'placed' },
      })
    ).status,
  ).toBe(409);
  const existing = {
    ...proof,
    native: { submission_id: 42, status: 'placed' },
  };
  expect((await call(b, 'inputs', existing)).status).toBe(200);
  db.closeDatabase();
  db.initDatabase();
  expect((await call(b, 'inputs', existing)).status).toBe(200);
  store.finishProductInput(row.id, false, () => {});
  expect((await call(b, 'inputs', existing)).status).toBe(409);
  expect(
    (
      await call(b, 'inputs', {
        ...proof,
        native: { submission_id: 42, status: 'unanswered' },
      })
    ).status,
  ).toBe(200);
  expect(calls).toBe(before);
});

test('late read/result authority does not grant execution and completion retries cannot change the committed answer', async () => {
  const id = session(),
    b = binding(id);
  db.ensureChatExists(`web:alice#agent:${id}`);
  const row = store.admitProductInput(
    id,
    randomUUID(),
    {
      content: 'original authorized input',
      followUpBehavior: 'queue',
      sender: 'alice',
      senderName: 'Alice',
    },
    () => {},
  );
  const proof = {
    input: {
      request_id: row.request_id,
      content: 'original authorized input',
      when_busy: 'followUp',
      product_receipt_digest: row.payload_digest,
    },
    native: { submission_id: 7, status: 'done' },
  };
  const result = {
    ...proof,
    result: {
      status: 'done',
      answer_entry_id: 99,
      text: 'ONE_COMMITTED_CLOUD_ANSWER',
    },
  };
  const time = vi.spyOn(Date, 'now').mockReturnValue(b.deadline_at + 1);
  try {
    const read = await call(b, 'policy', {
      binding_digest: await wire.bindingDigest(b),
      gateway_origin: 'https://cloud.fixture',
      purpose: 'read',
    });
    expect(read.status).toBe(200);
    await read.json();
    const execute = await call(b, 'policy', {
      binding_digest: await wire.bindingDigest(b),
      gateway_origin: 'https://cloud.fixture',
    });
    expect(execute.status).toBe(409);
    await execute.json();
    const before = calls;
    expect((await call(b, 'model', input, randomUUID())).status).toBe(409);
    expect(calls).toBe(before);
    const first = await call(b, 'results', result);
    expect(first.status).toBe(200);
    await first.json();
    const revision = store.getProductRuntime(id)!.revision;
    const duplicate = await call(b, 'results', result);
    expect(duplicate.status).toBe(200);
    await duplicate.json();
    expect(store.getProductRuntime(id)!.revision).toBe(revision);
    const changed = await call(b, 'results', {
      ...result,
      result: { ...result.result, text: 'UNTRUSTED_CHANGED_ANSWER' },
    });
    expect(changed.status).toBe(503);
    await changed.json();
    expect(
      db.getMessageText(
        `web:alice#agent:${id}`,
        store.productAnswerMessageId(row.id),
      ),
    ).toBe('ONE_COMMITTED_CLOUD_ANSWER');
    expect(store.listProductInputs(id)[0]).toMatchObject({
      submission_id: 7,
      state: 'completed',
    });
    const wrongSession = session();
    expect((await call(binding(wrongSession), 'results', result)).status).toBe(
      409,
    );
  } finally {
    time.mockRestore();
  }
});

test('Cloud Memory is explicitly granted at creation and the model proxy cannot widen that binding', async () => {
  vi.stubEnv('MINICLAW_CLOUD_RUNTIME', 'true');
  vi.stubEnv('MINICLAW_CLOUD_ORIGIN', 'https://cloud.fixture');
  vi.stubEnv('MINICLAW_CLOUD_SHARED_SECRET', secret);
  expect(
    model.selectNewProductRuntime('web:alice', 'cloudflare-durable').cloud
      ?.tool_capabilities,
  ).toBeUndefined();
  vi.stubEnv('MINICLAW_CLOUD_MEMORY', 'true');
  vi.stubEnv('MINICLAW_PERSONAL_MEMORY', 'true');
  expect(
    model.selectNewProductRuntime('web:alice', 'cloudflare-durable').cloud
      ?.tool_capabilities,
  ).toEqual(['read_personal_memory']);
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  expect(
    model.selectNewProductRuntime('web:alice', 'cloudflare-durable').cloud
      ?.tool_capabilities,
  ).toEqual(['read_personal_memory', 'create_approved_artifact']);
  const old = binding(session());
  const before = calls;
  const input = {
    model: old.model_id,
    stream: true,
    messages: [{ role: 'user', content: 'read' }],
    tools: [{ type: 'function', function: { name: 'read_personal_memory' } }],
  };
  expect((await call(old, 'model', input, randomUUID())).status).toBe(403);
  expect(
    (
      await call(
        old,
        'model',
        {
          ...input,
          tools: undefined,
          tool_choice: {
            type: 'function',
            function: { name: 'read_personal_memory' },
          },
        },
        randomUUID(),
      )
    ).status,
  ).toBe(403);
  expect(calls).toBe(before);
  const allowed = binding(session(true, 6, true, ['read_personal_memory']));
  const response = await call(
    allowed,
    'model',
    { ...input, model: allowed.model_id },
    randomUUID(),
  );
  expect(response.status).toBe(200);
  await response.text();
  expect(binding(old.session_id).tool_capabilities).toBeUndefined();
});

test('signed Cloud Memory gateway retains original grants, read receipts and live revocation', async () => {
  vi.stubEnv('MINICLAW_CLOUD_MEMORY', 'true');
  vi.stubEnv('MINICLAW_PERSONAL_MEMORY', 'true');
  db.setRegisteredGroup('web:alice-home', {
    name: 'Home',
    folder: 'alice-home',
    created_by: 'alice',
    executionMode: 'host',
    added_at: new Date().toISOString(),
    is_home: true,
  });
  const entry = personalMemory.createPersonalMemoryEntry(
    'alice',
    randomUUID(),
    {
      content: 'cloud-gateway-authorized-source',
      confirmed: true,
      allowed_workspaces: ['web:alice'],
    },
    () => {
      throw new Error('No artifact requested');
    },
  ).entry;
  personalMemory.createPersonalMemoryEntry(
    'alice',
    randomUUID(),
    {
      content: 'cloud-gateway-private-source',
      confirmed: true,
      allowed_workspaces: [],
    },
    () => {
      throw new Error('No artifact requested');
    },
  );
  const b = binding(session(true, 6, true, ['read_personal_memory']));
  const parameters = { query: 'cloud-gateway' };
  const input = {
    id: 'task:31',
    task_id: 31,
    conversation_id: 1,
    call_id: 'native-call-31',
    name: 'read_personal_memory',
    parameters,
    parameters_digest: await wire.digest(JSON.stringify(parameters)),
  };
  const response = await call(b, 'tools', input);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const snapshot = (await response.json()) as {
    output: { entries: { id: string; revision: number; content: string }[] };
  };
  expect(snapshot.output.entries.map((row) => row.content)).toEqual([
    'cloud-gateway-authorized-source',
  ]);
  expect(snapshot.output.entries[0]).toMatchObject({
    id: entry.item.id,
    revision: 1,
  });
  expect((await call(b, 'tools', input)).status).toBe(200);
  const raw = rawDb();
  try {
    expect(
      raw
        .prepare(
          'SELECT count(*) AS n FROM personal_memory_reads WHERE session_id=? AND tool_task_id=31',
        )
        .get(b.session_id),
    ).toEqual({ n: 1 });
  } finally {
    raw.close();
  }
  expect((await call(binding(session()), 'tools', input)).status).toBe(403);
  expect(
    (await call({ ...b, owner_user_id: 'bob' }, 'tools', input)).status,
  ).toBe(404);
  expect(
    (await call(b, 'tools', { ...input, conversation_id: 2 })).status,
  ).toBe(400);
  expect((await call(b, 'tools', { ...input, task_id: 32 })).status).toBe(409);
  expect(
    (await call(b, 'tools', { ...input, parameters: { query: 'changed' } }))
      .status,
  ).toBe(409);
  expect(
    (
      await call(b, 'tools', {
        ...input,
        parameters: { query: '', workspace_jid: 'web:bob' },
      })
    ).status,
  ).toBe(400);
  personalMemory.updatePersonalMemoryEntry(
    'alice',
    entry.item.id,
    randomUUID(),
    {
      expected_revision: 1,
      content: 'cloud-gateway-authorized-source',
      confirmed: true,
      allowed_workspaces: [],
    },
  );
  expect(
    ((await (await call(b, 'tools', input)).json()) as typeof snapshot).output
      .entries,
  ).toEqual([]);
  vi.stubEnv('MINICLAW_PERSONAL_MEMORY', 'false');
  expect(
    (
      (await (await call(b, 'tools', input)).json()) as {
        output: { status: string };
      }
    ).output.status,
  ).toBe('disabled');
  vi.stubEnv('MINICLAW_CLOUD_MEMORY', 'false');
  expect((await call(b, 'tools', input)).status).toBe(403);
});

async function artifactInput(taskId: number, content: string) {
  const parameters = { content };
  return {
    id: `task:${taskId}`,
    conversation_id: 1,
    task_id: taskId,
    generation_task_id: taskId - 1,
    call_id: `native-artifact-${taskId}`,
    name: 'create_approved_artifact',
    parameters,
    parameters_digest: await wire.digest(JSON.stringify(parameters)),
    phase: 'propose',
  };
}

test('Cloud artifact proposals require exact approval, immutable generation/call binding and original receipts for execution', async () => {
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  const approvals = await import('../src/personal-agent/approval-store.js');
  const b = binding(session(true, 6, true, ['create_approved_artifact']));
  const input = await artifactInput(101, 'Cloud approved exact content');
  const receipt = (await (await call(b, 'tools', input)).json()) as {
    output: {
      approval_id: string;
      state: string;
      parameters_digest: string;
      expires_at: string;
    };
  };
  expect(receipt.output.state).toBe('pending');
  expect(Date.parse(receipt.output.expires_at)).toBe(b.deadline_at);
  const target = path.join(
    root,
    'db/private-artifacts',
    receipt.output.approval_id + '.txt',
  );
  expect(fs.existsSync(target)).toBe(false);
  const bound = { ...input, approval_id: receipt.output.approval_id };
  expect(
    (
      (await (
        await call(b, 'tools', { ...bound, phase: 'execute' })
      ).json()) as typeof receipt
    ).output.state,
  ).toBe('pending');
  expect(fs.existsSync(target)).toBe(false);
  approvals.decideProductApproval(
    'alice',
    receipt.output.approval_id,
    receipt.output.parameters_digest,
    'approve',
    randomUUID(),
  );
  expect(
    (
      await call(b, 'tools', {
        ...bound,
        phase: 'execute',
        approval_id: undefined,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(b, 'tools', {
        ...bound,
        generation_task_id: 99,
        phase: 'execute',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(b, 'tools', {
        ...bound,
        call_id: 'different-call',
        phase: 'execute',
      })
    ).status,
  ).toBe(409);
  expect(fs.existsSync(target)).toBe(false);
  const executed = await call(b, 'tools', { ...bound, phase: 'execute' });
  expect(executed.status).toBe(200);
  expect(((await executed.json()) as typeof receipt).output.state).toBe(
    'completed',
  );
  expect(fs.readFileSync(target, 'utf8')).toBe(input.parameters.content);
  const before = fs.statSync(target).ino;
  expect((await call(b, 'tools', { ...bound, phase: 'execute' })).status).toBe(
    200,
  );
  expect(fs.statSync(target).ino).toBe(before);
  expect(approvals.listProductApprovals(b.session_id, 'alice')).toHaveLength(1);
  expect((await call(binding(session()), 'tools', input)).status).toBe(403);
});

test('Cloud artifact partial effects become uncertain without overwrite and an Abort intent fences a late execute', async () => {
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  const approvals = await import('../src/personal-agent/approval-store.js');
  const b = binding(session(true, 6, true, ['create_approved_artifact']));
  const input = await artifactInput(201, 'Expected complete contents');
  const proposed = (await (await call(b, 'tools', input)).json()) as {
    output: { approval_id: string; parameters_digest: string; state: string };
  };
  const bound = {
    ...input,
    approval_id: proposed.output.approval_id,
    phase: 'execute',
  };
  approvals.decideProductApproval(
    'alice',
    proposed.output.approval_id,
    proposed.output.parameters_digest,
    'approve',
    randomUUID(),
  );
  const target = path.join(
    root,
    'db/private-artifacts',
    proposed.output.approval_id + '.txt',
  );
  fs.mkdirSync(path.dirname(target), { mode: 0o700, recursive: true });
  fs.writeFileSync(target, 'partial', { mode: 0o600 });
  expect(
    ((await (await call(b, 'tools', bound)).json()) as typeof proposed).output
      .state,
  ).toBe('uncertain');
  expect(
    ((await (await call(b, 'tools', bound)).json()) as typeof proposed).output
      .state,
  ).toBe('uncertain');
  expect(fs.readFileSync(target, 'utf8')).toBe('partial');
  const late = await artifactInput(203, 'Must not execute after Abort');
  const next = (await (await call(b, 'tools', late)).json()) as typeof proposed;
  approvals.decideProductApproval(
    'alice',
    next.output.approval_id,
    next.output.parameters_digest,
    'approve',
    randomUUID(),
  );
  store.admitQueueControl(b.session_id, randomUUID(), {
    command: {
      action: 'abort',
      taskId: late.generation_task_id,
      expectedQueueDigest: 'a'.repeat(64),
    },
    targets: [],
  });
  expect(
    (
      await call(b, 'tools', {
        ...late,
        phase: 'execute',
        approval_id: next.output.approval_id,
      })
    ).status,
  ).toBe(409);
  expect(
    fs.existsSync(
      path.join(root, 'db/private-artifacts', next.output.approval_id + '.txt'),
    ),
  ).toBe(false);
});

test('Cloud artifact recovery cannot create a missing approval and execution expiry denies late writes', async () => {
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  const b = binding(session(true, 6, true, ['create_approved_artifact']));
  const input = await artifactInput(301, 'Expires with original Session grant');
  expect(
    (
      (await (await call(b, 'tools', { ...input, phase: 'probe' })).json()) as {
        output: { state: string };
      }
    ).output.state,
  ).toBe('missing');
  expect(
    (
      await call(b, 'tools', {
        ...input,
        phase: 'status',
        approval_id: randomUUID(),
      })
    ).status,
  ).toBe(409);
  const receipt = (await (await call(b, 'tools', input)).json()) as {
    output: { approval_id: string; state: string };
  };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(b.deadline_at + 1);
  try {
    const status = await call(b, 'tools', {
      ...input,
      phase: 'status',
      approval_id: receipt.output.approval_id,
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as typeof receipt).output.state).toBe(
      'denied',
    );
    expect(
      (
        await call(b, 'tools', {
          ...input,
          phase: 'execute',
          approval_id: receipt.output.approval_id,
        })
      ).status,
    ).toBe(409);
  } finally {
    clock.mockRestore();
  }
});

test('Cloud authorization expiring after the actual file effect records uncertainty instead of replaying a write', async () => {
  vi.stubEnv('MINICLAW_CLOUD_APPROVALS', 'true');
  const approvals = await import('../src/personal-agent/approval-store.js');
  const b = binding(session(true, 6, true, ['create_approved_artifact']));
  const input = await artifactInput(
    401,
    'Effect completed just before grant expiry',
  );
  const proposal = (await (await call(b, 'tools', input)).json()) as {
    output: { approval_id: string; parameters_digest: string };
  };
  approvals.decideProductApproval(
    'alice',
    proposal.output.approval_id,
    proposal.output.parameters_digest,
    'approve',
    randomUUID(),
  );
  const originalFsync = fs.fsyncSync;
  let clock: { mockRestore(): void } | undefined;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    originalFsync(fd);
    clock ??= vi.spyOn(Date, 'now').mockReturnValue(b.deadline_at + 1);
  });
  try {
    const response = await call(b, 'tools', {
      ...input,
      phase: 'execute',
      approval_id: proposal.output.approval_id,
    });
    expect(response.status).toBe(409);
  } finally {
    sync.mockRestore();
    clock?.mockRestore();
  }
  const record = approvals.getProductApproval(
    proposal.output.approval_id,
    'alice',
  );
  expect(record.state).toBe('uncertain');
  const file = path.join(root, 'db/private-artifacts', record.id + '.txt');
  expect(fs.readFileSync(file, 'utf8')).toBe(input.parameters.content);
  const inode = fs.statSync(file).ino;
  const retry = await call(b, 'tools', {
    ...input,
    phase: 'execute',
    approval_id: record.id,
  });
  expect(retry.status).toBe(200);
  expect(
    ((await retry.json()) as { output: { state: string } }).output.state,
  ).toBe('uncertain');
  expect(fs.statSync(file).ino).toBe(inode);
});

async function cloudHandoffAuthorityFixture() {
  const groups = await import('../src/bot-groups/store.js');
  const handoffs = await import('../src/bot-groups/handoff-store.js');
  const profile = db.getOrCreateDefaultAgentProfile('alice');
  db.assignWorkspaceAgentProfile('alice', profile.id);
  const created = groups.createBotGroup('alice', randomUUID(), {
    name: 'Private Cloud lifecycle authority fixture',
    workspace_jid: 'web:alice',
  });
  const first = groups.getBotGroupSnapshot('alice', created.group_id);
  const bot = first.members.find((member) => member.kind === 'bot')!;
  groups.patchBotGroupMember('alice', created.group_id, bot.id, randomUUID(), {
    scope_workspace_jid: 'web:alice',
    expected_revision: first.revision,
  });
  const current = groups.getBotGroupSnapshot('alice', created.group_id);
  const target = current.members.find((member) => member.id === bot.id)!;
  const configured = model.productModelConfiguration('web:alice', providerId);
  handoffs.grantBotRuntime(
    'alice',
    created.group_id,
    bot.id,
    randomUUID(),
    {
      expected_revision: current.revision,
      expected_member_revision: target.revision,
      runtime_kind: 'cloudflare-durable',
      tool_capabilities: [],
      max_model_attempts: 4,
    },
    () => ({ providerId, configFingerprint: configured.fingerprint }),
  );
  const message = groups.postBotGroupMessage(
    'alice',
    created.group_id,
    randomUUID(),
    { content: 'Explicit lifecycle authority test' },
  );
  const admitted = handoffs.admitGroupMessageHandoffs(
    'alice',
    created.group_id,
    message.message_id,
  )[0];
  const linked = handoffs.bindBotHandoffSession(
    'alice',
    admitted.id,
    ({ sessionId, handoff, grant }) => {
      db.createAgent(
        {
          id: sessionId,
          chat_jid: 'web:alice',
          group_folder: 'alice',
          name: 'Private Cloud Handoff',
          kind: 'conversation',
          prompt: '',
          status: 'idle',
          created_by: 'alice',
          created_at: new Date().toISOString(),
          completed_at: null,
          result_summary: null,
          last_im_jid: null,
          spawned_from_jid: null,
        },
        {
          kind: 'pi-durable',
          providerId,
          configFingerprint: configured.fingerprint,
          cloud: {
            runtime_id: randomUUID(),
            gateway_origin: 'https://cloud.fixture',
            model_id: configured.modelId,
            instructions: '',
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
    },
  );
  const b = binding(linked.session_id!);
  store.bindCloudObject(linked.session_id!, b.runtime_id, 'a'.repeat(64));
  store.bindProductConversation(linked.session_id!, 1);
  return { linked, b, handoffs, groups };
}
test('signed Handoff resume policy requires its current pending revision and live Host/Workspace authority; stop-only proof survives Host revocation', async () => {
  const { linked, b, handoffs } = await cloudHandoffAuthorityFixture();
  const fence = (revision: number) => ({
    kind: 'handoff' as const,
    handoff_id: linked.id,
    handoff_revision: revision,
  });
  const paused = handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'paused',
    'authority_test_pause',
  );
  expect(
    (await call(b, 'stop-policy', { fence: fence(paused.revision) })).status,
  ).toBe(200);
  const resumed = handoffs.transitionBotHandoff(
    'alice',
    linked.id,
    'pending',
    'authority_test_resume',
  );
  const body = {
    binding_digest: await wire.bindingDigest(b),
    gateway_origin: 'https://cloud.fixture',
    handoff_resume: fence(resumed.revision),
  };
  const response = await call(b, 'policy', body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    fence_digest: await wire.digest(JSON.stringify(body.handoff_resume)),
  });
  expect(
    (
      await call(b, 'policy', {
        ...body,
        handoff_resume: fence(paused.revision),
      })
    ).status,
  ).toBe(409);
  expect((await call(b, 'policy', { ...body, purpose: 'read' })).status).toBe(
    409,
  );
  expect(
    (
      await call(b, 'policy', {
        ...body,
        handoff_resume: { ...body.handoff_resume, mode: 'active' },
      })
    ).status,
  ).toBe(400);
  expect(
    (await call({ ...b, owner_user_id: 'bob' }, 'policy', body)).status,
  ).toBe(404);
  const before = calls;
  const connection = rawDb();
  try {
    connection.prepare("UPDATE users SET role='member' WHERE id='alice'").run();
    expect((await call(b, 'policy', body)).status).not.toBe(200);
    // Restrictive product state is persisted before closing the remote owner.
    connection
      .prepare(
        "UPDATE bot_group_handoffs SET state='paused',revision=revision+1 WHERE id=?",
      )
      .run(linked.id);
    const stopped = handoffs.getBotHandoff(linked.id)!;
    expect(
      (await call(b, 'stop-policy', { fence: fence(stopped.revision) })).status,
    ).toBe(200);
    expect(
      (
        await call(b, 'policy', {
          ...body,
          handoff_resume: fence(stopped.revision),
        })
      ).status,
    ).not.toBe(200);
  } finally {
    connection.prepare("UPDATE users SET role='admin' WHERE id='alice'").run();
    connection.close();
  }
  expect(calls).toBe(before); // Policy cannot itself invoke the model.
});

test('signed Node progress verifies the original Handoff input, deduplicates after reopen and derives approvals from product rows only (native frame supplied as fixture)', async () => {
  const { linked, b, handoffs, groups } = await cloudHandoffAuthorityFixture();
  const original = store.admitProductInput(
    linked.session_id!,
    linked.request_id,
    {
      content: linked.payload,
      sender: 'alice',
      senderName: (JSON.parse(linked.payload) as { actor_name: string })
        .actor_name,
      followUpBehavior: 'queue',
    },
    () => {},
  );
  const value = {
    input: {
      request_id: original.request_id,
      content: linked.payload,
      when_busy: 'followUp',
      product_receipt_digest: original.payload_digest,
    },
    native: { submission_id: 7, status: 'placed' },
    progress: {
      handoff: b.bot_handoff!,
      revision: 1,
      control_revision: 0,
      frame: {
        runtime_state: 'waiting_for_approval',
        run_task_id: 3,
        queue_digest: 'a'.repeat(64),
        partial_text: 'SIGNED_PROGRESS_FIXTURE',
        tools: [],
      },
    },
  };
  const before = calls;
  const first = await call(b, 'progress', value);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    accepted: true,
    revision: 1,
    last_revision: 1,
  });
  expect(handoffs.getBotHandoff(linked.id)).toMatchObject({
    state: 'running',
    submission_id: 7,
    result_message_id: null,
    task_id: null,
  });
  expect(store.listProductInputs(linked.session_id!)[0]).toMatchObject({
    state: 'submitted',
    submission_id: 7,
  });
  const revision = groups.getBotGroupSnapshot(
    'alice',
    linked.group_id,
  ).revision;
  db.closeDatabase();
  db.initDatabase();
  expect((await call(b, 'progress', value)).status).toBe(200);
  expect(groups.getBotGroupSnapshot('alice', linked.group_id).revision).toBe(
    revision,
  );
  const conflict = {
    ...value,
    progress: {
      ...value.progress,
      frame: { ...value.progress.frame, partial_text: 'forged changed replay' },
    },
  };
  expect((await call(b, 'progress', conflict)).status).not.toBe(200);
  expect(
    (await call({ ...b, owner_user_id: 'bob' }, 'progress', value)).status,
  ).toBe(404);
  expect(
    (
      await call(b, 'progress', {
        ...value,
        native: { ...value.native, submission_id: 8 },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(b, 'progress', {
        ...value,
        progress: { ...value.progress, approval: { state: 'approved' } },
      })
    ).status,
  ).toBe(400);
  const approvals = await import('../src/personal-agent/approval-store.js');
  const approval = approvals.requestArtifactApproval(
    linked.session_id!,
    9,
    'EXACT_PROGRESS_APPROVAL_FIXTURE',
  );
  expect(approval.state).toBe('pending');
  const next = { ...value, progress: { ...value.progress, revision: 2 } };
  expect((await call(b, 'progress', next)).status).toBe(200);
  expect(handoffs.getBotHandoff(linked.id)?.state).toBe('waiting_for_approval');
  expect(approvals.getProductApproval(approval.id, 'alice').state).toBe(
    'pending',
  );
  expect(calls).toBe(before); // Progress cannot invoke a model or execute a tool.
});
