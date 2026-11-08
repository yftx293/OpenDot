import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { ProviderStreams, AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
import {
  meteredModelApi,
  PRODUCT_MODEL_REQUEST_TIMEOUT_MS,
} from '../src/personal-agent/metered-model-api.js';
afterEach(() => vi.useRealTimers());
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-metering-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const config = await import('../src/runtime-config.js');
const { createProductModels, productModelConfiguration } =
  await import('../src/personal-agent/product-model.js');
// This suite asserts inference accounting, not Vite's first transformation of
// the real OpenAI SDK. Resolve that code before the unchanged five-second
// operation budget. Product HTTP/restart suites still exercise cold native
// loading with the production request deadline and actual transport.
await import('@earendil-works/pi-ai/api/openai-completions');
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});
test('model discovery/auth/recovery do not spend inference budget; dispatch charges once', async () => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'owner',
    username: 'owner',
    password_hash: 'fixture',
    display_name: 'Owner',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:meter', {
    name: 'Meter',
    folder: 'meter',
    executionMode: 'host',
    created_by: 'owner',
    added_at: now,
  });
  const provider = config.createProvider({
    name: 'Meter fixture',
    type: 'third_party',
    anthropicBaseUrl: 'http://127.0.0.1:1/v1',
    anthropicApiKey: 'test-key',
    anthropicModel: 'meter-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  });
  const selected = productModelConfiguration('web:meter', provider.id);
  const runtime = {
    session_id: randomUUID(),
    workspace_jid: 'web:meter',
    provider_id: provider.id,
    config_fingerprint: selected.fingerprint,
  } as Parameters<typeof createProductModels>[0];
  const charge = vi.fn(),
    authorize = vi.fn();
  const { models, model: selection } = createProductModels(
    runtime,
    authorize,
    charge,
  );
  await models.checkAuth(selection.provider);
  await models.getAvailable(selection.provider);
  await models.getAuth(selection.provider);
  await models.refresh();
  expect(charge).not.toHaveBeenCalled();
  let requests = 0;
  const model = models.getModel(selection.provider, selection.modelId)!;
  const fetch = async () => {
    requests++;
    return new Response(
      'data: ' +
        JSON.stringify({
          id: 'meter',
          object: 'chat.completion.chunk',
          created: 0,
          model: model.id,
          choices: [
            { index: 0, delta: { content: 'OK' }, finish_reason: 'stop' },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const reply = await models.completeSimple(
    model,
    { messages: [{ role: 'user', content: 'OK', timestamp: Date.now() }] },
    { fetch },
  );
  expect(reply.stopReason).toBe('stop');
  expect(requests).toBe(1);
  expect(charge).toHaveBeenCalledTimes(1);
  await models.checkAuth(selection.provider);
  expect(charge).toHaveBeenCalledTimes(1);
});

function streamingFixture() {
  const model: Parameters<ProviderStreams['stream']>[0] = {
    id: 'fixture',
    name: 'Fixture',
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'partial' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'pending',
    timestamp: Date.now(),
  };
  const source = new AssistantMessageEventStream();
  const dispatch = vi.fn(
    (..._args: Parameters<ProviderStreams['stream']>) => source,
  );
  const charge = vi.fn();
  const deferred = vi.fn();
  const api = meteredModelApi(
    { stream: dispatch, streamSimple: dispatch, fetchDeferred: deferred },
    () => {},
    charge,
  );
  return { model, message, source, dispatch, charge, api, deferred };
}
test('a stalled model is bounded, cannot hide transport retries, and ignores late success', async () => {
  vi.useFakeTimers();
  const f = streamingFixture();
  const caller = new AbortController();
  const output = f.api.streamSimple(
    f.model,
    { messages: [] },
    { signal: caller.signal, maxRetries: 5, timeoutMs: 120000 },
  );
  f.source.push({ type: 'start', partial: f.message });
  await Promise.resolve();
  expect(f.dispatch.mock.calls[0][2]?.maxRetries).toBe(0);
  expect(f.dispatch.mock.calls[0][2]?.timeoutMs).toBe(
    PRODUCT_MODEL_REQUEST_TIMEOUT_MS,
  );
  await vi.advanceTimersByTimeAsync(PRODUCT_MODEL_REQUEST_TIMEOUT_MS);
  const failed = await output.result();
  expect(failed.stopReason).toBe('error');
  expect(failed.errorMessage).toBe('MODEL_REQUEST_TIMEOUT');
  expect(isRetryableAssistantError(failed)).toBe(true);
  expect(f.dispatch.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(caller.signal.aborted).toBe(false);
  (f.message.content[0] as { text: string }).text = 'late private mutation';
  expect(failed.content).toEqual([{ type: 'text', text: 'partial' }]);
  f.source.push({
    type: 'done',
    reason: 'stop',
    message: { ...f.message, stopReason: 'stop' },
  });
  f.source.end();
  expect((await output.result()).stopReason).toBe('error');
  expect(f.charge).toHaveBeenCalledTimes(1);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
test('successful streams keep their result, release the timer, and preserve deferred APIs', async () => {
  vi.useFakeTimers();
  const f = streamingFixture();
  const output = f.api.stream(f.model, { messages: [] });
  f.source.push({
    type: 'done',
    reason: 'stop',
    message: { ...f.message, stopReason: 'stop' },
  });
  f.source.end();
  expect((await output.result()).stopReason).toBe('stop');
  await vi.advanceTimersByTimeAsync(PRODUCT_MODEL_REQUEST_TIMEOUT_MS);
  expect(f.dispatch.mock.calls[0][2]?.signal?.aborted).toBe(false);
  expect(f.api.fetchDeferred).toBe(f.deferred);
  expect(vi.getTimerCount()).toBe(0);
});
test('user cancellation remains aborted instead of becoming a retryable timeout', async () => {
  vi.useFakeTimers();
  const f = streamingFixture(),
    caller = new AbortController();
  const output = f.api.streamSimple(
    f.model,
    { messages: [] },
    { signal: caller.signal, timeoutMs: 20 },
  );
  caller.abort();
  f.source.push({
    type: 'error',
    reason: 'aborted',
    error: { ...f.message, stopReason: 'aborted' },
  });
  f.source.end();
  const cancelled = await output.result();
  expect(cancelled.stopReason).toBe('aborted');
  expect(isRetryableAssistantError(cancelled)).toBe(false);
  await vi.advanceTimersByTimeAsync(PRODUCT_MODEL_REQUEST_TIMEOUT_MS);
  expect(f.charge).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('default model fetch uses the same undici dispatcher and custom transport errors expose only a known code', async () => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } =
    await import('undici');
  const previous = getGlobalDispatcher(),
    agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get('https://model.fixture')
    .intercept({ path: '/probe', method: 'GET' })
    .reply(200, 'MATCHED_TRANSPORT');
  setGlobalDispatcher(agent);
  try {
    const f = streamingFixture();
    const output = f.api.stream(f.model, { messages: [] });
    const fetch = f.dispatch.mock.calls[0][2]!.fetch!;
    const response = await fetch('https://model.fixture/probe');
    expect(await response.text()).toBe('MATCHED_TRANSPORT');
    f.source.push({
      type: 'done',
      reason: 'stop',
      message: { ...f.message, stopReason: 'stop' },
    });
    f.source.end();
    expect((await output.result()).stopReason).toBe('stop');
  } finally {
    setGlobalDispatcher(previous);
    await agent.close();
  }
  const f = streamingFixture(),
    secret = 'private-transport-secret';
  const custom = vi.fn(async () => {
    throw Object.assign(new Error(secret), {
      cause: { code: 'ECONNRESET', message: secret },
    });
  });
  const output = f.api.streamSimple(
    f.model,
    { messages: [] },
    { fetch: custom },
  );
  await expect(
    f.dispatch.mock.calls[0][2]!.fetch!('https://model.fixture/private'),
  ).rejects.toThrow(secret);
  f.source.push({
    type: 'error',
    reason: 'error',
    error: {
      ...f.message,
      stopReason: 'error',
      errorMessage: 'Connection error',
    },
  });
  f.source.end();
  const result = await output.result();
  expect(result.errorMessage).toBe('Connection error [ECONNRESET]');
  expect(result.errorMessage).not.toContain(secret);
  expect(custom).toHaveBeenCalledTimes(1);
  expect(f.charge).toHaveBeenCalledTimes(1);
});

test('the actual SDK and HTTP transport cancel a held request promptly', async () => {
  let accepted!: () => void,
    closed = false;
  const received = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume only this synthetic request */
    }
    response.once('close', () => {
      closed = true;
    });
    accepted();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = config.createProvider({
      name: 'Cancellation HTTP fixture',
      type: 'third_party',
      enabled: true,
      anthropicBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      anthropicApiKey: 'synthetic-cancel-key',
      anthropicModel: 'cancel-model',
      customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
    });
    config.setDefaultProvider(provider.id);
    const selected = productModelConfiguration('web:meter', provider.id);
    const { models, model: selection } = createProductModels(
      {
        session_id: randomUUID(),
        workspace_jid: 'web:meter',
        provider_id: provider.id,
        config_fingerprint: selected.fingerprint,
      } as Parameters<typeof createProductModels>[0],
      () => {},
    );
    const model = models.getModel(selection.provider, selection.modelId)!;
    const output = models.streamSimple(
      model,
      {
        messages: [
          {
            role: 'user',
            content: 'Wait until cancelled',
            timestamp: Date.now(),
          },
        ],
      },
      { signal: controller.signal },
    );
    await received;
    const began = Date.now();
    controller.abort();
    const reply = await Promise.race([
      output.result(),
      new Promise<never>(
        (_, reject) =>
          (cancellationTimer = setTimeout(
            () => reject(new Error('Model cancellation did not settle')),
            2000,
          )),
      ),
    ]);
    expect(reply.stopReason).toBe('aborted');
    expect(Date.now() - began).toBeLessThan(1500);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
  } finally {
    clearTimeout(cancellationTimer);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 10000);

test('explicit output limit is bounded and frozen in Durable model identity', () => {
  const provider = config.createProvider({
    name: 'Output budget fixture',
    type: 'third_party',
    enabled: true,
    anthropicBaseUrl: 'http://127.0.0.1:1/v1',
    anthropicApiKey: 'fixture-key',
    anthropicModel: 'fixture-model',
    customEnv: { MINICLAW_MODEL_API: 'openai-completions' },
  });
  const original = productModelConfiguration('web:meter', provider.id);
  expect(original.maxOutputTokens).toBe(4096);
  config.updateProvider(provider.id, {
    customEnv: {
      MINICLAW_MODEL_API: 'openai-completions',
      MINICLAW_MODEL_MAX_OUTPUT_TOKENS: '8192',
    },
  });
  const raised = productModelConfiguration('web:meter', provider.id);
  expect(raised.maxOutputTokens).toBe(8192);
  expect(raised.fingerprint).not.toBe(original.fingerprint);
  const { models, model: selection } = createProductModels(
    {
      session_id: randomUUID(),
      workspace_jid: 'web:meter',
      provider_id: provider.id,
      config_fingerprint: raised.fingerprint,
    } as Parameters<typeof createProductModels>[0],
    () => {},
  );
  expect(
    models.getModel(selection.provider, selection.modelId)?.maxTokens,
  ).toBe(8192);
  config.updateProvider(provider.id, {
    customEnv: { MINICLAW_MODEL_MAX_OUTPUT_TOKENS: '999999' },
  });
  expect(() => productModelConfiguration('web:meter', provider.id)).toThrow(
    'output limit',
  );
});

test('a completed observed answer carries trusted trace identity while provider context omits it', async () => {
  const fixture = streamingFixture();
  const expectedTrace = 'b'.repeat(32);
  const api = meteredModelApi(
    {
      stream: fixture.dispatch,
      streamSimple: fixture.dispatch,
      fetchDeferred: fixture.deferred,
    },
    () => {},
    fixture.charge,
    () => ({ completedTraceId: () => expectedTrace }),
  );
  const previous = {
    ...fixture.message,
    stopReason: 'stop' as const,
    __opendot_trace_id: 'a'.repeat(32),
  };
  const output = api.stream(
    fixture.model,
    { messages: [previous] },
    {
      fetch: (async () => new Response('ok')) as typeof fetch,
    },
  );
  const sent = fixture.dispatch.mock.calls[0]![1];
  expect(JSON.stringify(sent)).not.toContain('__opendot_trace_id');
  expect(previous.__opendot_trace_id).toBe('a'.repeat(32));
  await fixture.dispatch.mock.calls[0]![2]!.fetch!('http://synthetic.test');
  fixture.source.push({
    type: 'done',
    reason: 'stop',
    message: {
      ...fixture.message,
      stopReason: 'stop',
      __opendot_trace_id: 'c'.repeat(32),
    } as AssistantMessage,
  });
  fixture.source.end();
  const answer = (await output.result()) as AssistantMessage & {
    __opendot_trace_id?: string;
  };
  expect(answer.__opendot_trace_id).toBe(expectedTrace);
});
