import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { AssistantMessage, ProviderStreams } from '@earendil-works/pi-ai';
import { meteredModelApi } from '../src/personal-agent/metered-model-api.js';
import {
  BoundedLangfuseExporter,
  HostObservability,
  type NativeModelIdentity,
} from '../src/personal-agent/host-observability.js';

const model: Parameters<ProviderStreams['stream']>[0] = {
  id: 'synthetic-model',
  name: 'Synthetic',
  provider: 'fixture',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1/v1',
  reasoning: false,
  input: ['text'],
  contextWindow: 4096,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const done: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'DO NOT EXPORT THIS ANSWER' }],
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
  stopReason: 'stop',
  timestamp: Date.now(),
};
const identity = (sessionId: string, task: number): NativeModelIdentity => ({
  sessionId,
  ownerId: 'owner',
  conversationId: task,
  generationTaskId: task,
  attempt: 1,
  inputRequestIds: ['original-business-input'],
  modelId: model.id,
  runtime: 'node-durable',
});

test('tool observations export only allowlisted metadata', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    tracer.tool(identity('session', 4), {
      taskId: 9,
      name: 'sensitive external tool name',
      startedAt: 1000,
      endedAt: 1150,
      isError: true,
      nested: true,
    });
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('dot.tool.execution');
    const serialized = JSON.stringify(spans[0]!.attributes);
    expect(serialized).not.toContain('sensitive external tool name');
    expect(serialized).not.toContain('original-business-input');
    expect(serialized).toContain('other');
    expect(serialized).toContain('tool_result_before_commit');
  } finally {
    await tracer.close();
  }
});

test('actual async admission, provider call and settlement remain separate; metadata spans stay isolated', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'DO NOT EXPORT THIS KEY',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    const sessions = [randomUUID(), randomUUID()];
    const run = async (sessionId: string, task: number) => {
      let release!: () => void;
      const capacity = new Promise<void>((resolve) => {
        release = resolve;
      });
      let dispatchCount = 0,
        settleCount = 0,
        providerCount = 0;
      const source = new AssistantMessageEventStream();
      const observer = tracer.model(identity(sessionId, task));
      const provider: ProviderStreams['stream'] = (
        _model,
        _context,
        options,
      ) => {
        providerCount++;
        void options?.fetch?.('https://synthetic-provider.test/v1/response');
        return source;
      };
      const api = meteredModelApi(
        {
          stream: provider,
          streamSimple: provider,
          fetchDeferred: vi.fn(),
        },
        () => {},
        async () => {
          await capacity;
          return {
            dispatch: () => {
              dispatchCount++;
            },
            settle: () => {
              settleCount++;
            },
          };
        },
        () => observer,
      );
      const output = api.streamSimple(
        model,
        normalizeContext({
          messages: [
            {
              role: 'user',
              content: 'DO NOT EXPORT THIS PROMPT',
              timestamp: 1,
            },
          ],
        }),
        { fetch: async () => new Response('fixture') },
      );
      expect(providerCount).toBe(0);
      expect(dispatchCount).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 12));
      release();
      await vi.waitFor(() => expect(providerCount).toBe(1));
      source.push({ type: 'done', reason: 'stop', message: done });
      source.end();
      expect((await output.result()).stopReason).toBe('stop');
      expect(dispatchCount).toBe(1);
      expect(settleCount).toBe(1);
    };
    await Promise.all(
      sessions.map((session, index) => run(session, index + 1)),
    );
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(
      spans.filter((s) => s.name === 'dot.model.admission_wait'),
    ).toHaveLength(2);
    expect(spans.filter((s) => s.name === 'dot.model.generation')).toHaveLength(
      2,
    );
    const generations = spans.filter((s) => s.name === 'dot.model.generation');
    expect(generations[0].spanContext().traceId).not.toBe(
      generations[1].spanContext().traceId,
    );
    for (const generation of generations) {
      const parent = spans.find(
        (s) => s.spanContext().spanId === generation.parentSpanContext?.spanId,
      );
      expect(parent?.name).toBe('dot.model.admission_wait');
      expect(generation.startTime).not.toEqual(parent?.startTime);
    }
    const encoded = JSON.stringify(spans.map((span) => span.attributes));
    expect(encoded).not.toContain('DO NOT EXPORT');
    expect(encoded).not.toContain('original-business-input');
    expect(encoded).not.toContain('cost_details');
    expect(encoded).toContain('unknown');
  } finally {
    await tracer.close();
  }
});

test('sampling zero creates no trace and observation failures cannot change dispatch or accounting', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 0,
    exporter: memory,
  });
  try {
    expect(tracer.model(identity(randomUUID(), 1))).toBeUndefined();
    let settled = 0;
    const source = new AssistantMessageEventStream();
    const provider = vi.fn(() => source);
    const api = meteredModelApi(
      { stream: provider, streamSimple: provider, fetchDeferred: vi.fn() },
      () => {},
      () => ({
        dispatch() {},
        settle() {
          settled++;
        },
      }),
      () => ({
        admitted() {
          throw new Error('telemetry unavailable');
        },
        dispatched() {
          throw new Error('telemetry unavailable');
        },
        finished() {
          throw new Error('telemetry unavailable');
        },
      }),
    );
    const output = api.streamSimple(model, normalizeContext({ messages: [] }));
    source.push({ type: 'done', reason: 'stop', message: done });
    source.end();
    expect((await output.result()).stopReason).toBe('stop');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(settled).toBe(1);
    await tracer.flush();
    expect(memory.getFinishedSpans()).toHaveLength(0);
  } finally {
    await tracer.close();
  }
});

test('a stuck collector cannot grow the in-memory export queue beyond its byte cap', async () => {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memory)],
  });
  provider.getTracer('fixture').startSpan('dot.fixture').end();
  const span = memory.getFinishedSpans()[0];
  const bytes = JsonTraceSerializer.serializeRequest([span])!.byteLength;
  let release!: () => void;
  const delegate: SpanExporter = {
    export: (_spans, callback) => {
      release = () => callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  };
  const bounded = new BoundedLangfuseExporter(delegate, bytes, 2);
  let acknowledgements = 0;
  bounded.export([span], () => {
    acknowledgements++;
  });
  await Promise.resolve(); // the first export is now stuck inside the collector
  bounded.export([span], () => {
    acknowledgements++;
  });
  expect(bounded.metrics.dropped).toBe(1);
  expect(acknowledgements).toBe(1);
  release();
  await bounded.forceFlush();
  expect(acknowledgements).toBe(2);
  expect(bounded.metrics.exported).toBe(1);
  await bounded.shutdown();
  await provider.shutdown();
});

test('a timed-out exporter opens the circuit and never stacks later batches behind the same stuck outlet', async () => {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memory)],
  });
  provider.getTracer('fixture').startSpan('dot.fixture').end();
  const span = memory.getFinishedSpans()[0]!;
  const bytes = JsonTraceSerializer.serializeRequest([span])!.byteLength;
  let late!: (result: { code: ExportResultCode }) => void;
  let calls = 0,
    shutdowns = 0;
  const delegate: SpanExporter = {
    export: (_spans, callback) => {
      calls++;
      if (calls === 1) late = callback;
      else callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {
      shutdowns++;
    },
  };
  const bounded = new BoundedLangfuseExporter(delegate, bytes * 4, 4, 15);
  let acknowledgements = 0;
  for (let i = 0; i < 4; i++) bounded.export([span], () => acknowledgements++);
  await bounded.forceFlush();
  // Only the first batch reached the stuck delegate; the three queued batches
  // were released instead of being sent behind it.
  expect(calls).toBe(1);
  expect(acknowledgements).toBe(4);
  expect(bounded.metrics).toEqual({ exported: 0, dropped: 3, failed: 1 });
  // A late ACK cannot reopen the circuit, and later spans stay dropped.
  late({ code: ExportResultCode.SUCCESS });
  bounded.export([span], () => acknowledgements++);
  expect(acknowledgements).toBe(5);
  expect(calls).toBe(1);
  expect(bounded.metrics).toEqual({ exported: 0, dropped: 4, failed: 1 });
  // Shutdown must not wait behind the delegate's own unbounded flush.
  await bounded.shutdown();
  expect(shutdowns).toBe(0);
  await provider.shutdown();
});

test('pre-transport failure stays distinct from two real provider attempts for the same input', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    const session = randomUUID();
    const noTransport = tracer.model(identity(session, 1))!;
    noTransport.admitted?.(Date.now());
    noTransport.dispatched?.(Date.now());
    noTransport.finished?.({ kind: 'error' }, Date.now(), false);
    for (const [task, kind] of [
      [2, 'error'],
      [3, 'done'],
    ] as const) {
      const attempt = tracer.model({
        ...identity(session, task),
        attempt: task - 1,
      })!;
      attempt.admitted?.(Date.now());
      attempt.dispatched?.(Date.now());
      attempt.providerRequestStarted?.(Date.now());
      attempt.finished?.({ kind }, Date.now(), true);
    }
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(
      spans.filter((s) => s.name === 'dot.model.no_transport'),
    ).toHaveLength(1);
    const generations = spans.filter((s) => s.name === 'dot.model.generation');
    expect(generations).toHaveLength(2);
    expect(generations[0].spanContext().spanId).not.toBe(
      generations[1].spanContext().spanId,
    );
  } finally {
    await tracer.close();
  }
});

test('capacity wait and provider attempt use their actual lifecycle timestamps', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    const at = Date.now();
    const observed = tracer.model(identity(randomUUID(), 5))!;
    observed.admitted?.(at);
    observed.dispatched?.(at + 1_000);
    observed.providerRequestStarted?.(at + 1_000);
    observed.finished?.({ kind: 'done', usage: done.usage }, at + 1_025, true);
    await tracer.flush();
    const wait = memory
      .getFinishedSpans()
      .find((span) => span.name === 'dot.model.admission_wait')!;
    const generation = memory
      .getFinishedSpans()
      .find((span) => span.name === 'dot.model.generation')!;
    const millis = (time: readonly [number, number]) =>
      time[0] * 1_000 + time[1] / 1_000_000;
    expect(millis(wait.endTime) - millis(wait.startTime)).toBe(1_000);
    expect(millis(generation.endTime) - millis(generation.startTime)).toBe(25);
    expect(millis(generation.startTime)).toBe(millis(wait.endTime));
    expect(generation.attributes).not.toHaveProperty('usage_details');
    expect(generation.attributes).not.toHaveProperty('cost_details');
  } finally {
    await tracer.close();
  }
});

test('qualified model identifiers remain distinguishable without exporting URLs', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    for (const [task, modelId] of [
      [1, 'opencode-go-3/beam-free'],
      [2, 'https://example.test/model?key=DO_NOT_EXPORT'],
    ] as const) {
      const observation = tracer.model({ ...identity(randomUUID(), task), modelId })!;
      observation.admitted?.(1000);
      observation.dispatched?.(1001);
      observation.providerRequestStarted?.(1002);
      observation.finished?.({ kind: 'done' }, 1003, true);
    }
    await tracer.flush();
    const attributes = JSON.stringify(memory.getFinishedSpans().map((span) => span.attributes));
    expect(attributes).toContain('opencode-go-3/beam-free');
    expect(attributes).toContain('custom-model');
    expect(attributes).not.toContain('DO_NOT_EXPORT');
  } finally {
    await tracer.close();
  }
});

test('MCP ledger observations preserve decision and uncertain receipt without private content', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    const receipt = {
      id: 'private-call',
      owner_user_id: 'private-owner',
      session_id: 'session',
      created_at: 1000,
      decided_at: 1200,
      dispatched_at: 1300,
      settled_at: 1500,
      state: 'approved',
      intent: {
        server_id: 'private-server',
        original_name: 'private-tool',
        location: { kind: 'device' },
        source: {
          runtime: 'pi-durable',
          generation_task_id: 4,
          tool_task_id: 9,
          inputs: [{ request_id: 'private-request' }],
        },
      },
    } as unknown as import('../src/personal-agent/mcp-approval-store.js').McpApproval;
    tracer.mcpReceipt(receipt, 'decision');
    tracer.mcpReceipt({ ...receipt, state: 'uncertain' }, 'execution');
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      'dot.mcp.approval',
      'dot.mcp.execution',
    ]);
    const text = JSON.stringify(spans.map((span) => span.attributes));
    expect(text).toContain('uncertain');
    for (const secret of [
      'private-call',
      'private-owner',
      'private-server',
      'private-tool',
      'private-request',
      'fixture-secret',
    ])
      expect(text).not.toContain(secret);
  } finally {
    await tracer.close();
  }
});

test('memory recall observation exports only bounded metadata', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    tracer.memoryOperation({
      ownerId: 'secret-owner',
      sessionId: 'session',
      inputId: 'secret-request',
      profileId: 'secret-dot',
      runtime: 'node-durable',
      operation: 'search',
      startedAt: 1000,
      endedAt: 1050,
      state: 'completed',
      cache: 'hit',
      resultCount: 2,
      policyVersion: 1,
    });
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('dot.memory.search');
    const text = JSON.stringify(spans[0]!.attributes);
    expect(text).toContain('hit');
    for (const secret of [
      'secret-owner',
      'secret-request',
      'secret-dot',
      'fixture-secret',
    ])
      expect(text).not.toContain(secret);
  } finally {
    await tracer.close();
  }
});

test('memory add records asynchronous acceptance without exporting its payload or event id', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    tracer.memoryCapture({
      ownerId: 'secret-owner',
      sessionId: 'session',
      inputId: 'secret-input',
      profileId: 'secret-dot',
      captureId: 'secret-capture',
      runtime: 'coding',
      attempt: 1,
      policyVersion: 1,
      startedAt: 1000,
      endedAt: 1100,
      state: 'accepted',
      eventId: 'secret-event',
    });
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('dot.memory.add');
    const text = JSON.stringify(spans[0]!.attributes);
    expect(text).toContain('accepted');
    expect(text).toContain('unconfirmed');
    for (const secret of [
      'secret-owner',
      'secret-input',
      'secret-dot',
      'secret-capture',
      'secret-event',
      'fixture-secret',
    ])
      expect(text).not.toContain(secret);
  } finally {
    await tracer.close();
  }
});

test('Coding MCP uses its own turn and call identities without invented Durable tasks', async () => {
  const memory = new InMemorySpanExporter();
  const tracer = new HostObservability({
    publicKey: 'fixture-public',
    secretKey: 'fixture-secret',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter: memory,
  });
  try {
    const receipt = {
      id: 'private-call',
      owner_user_id: 'private-owner',
      session_id: 'session',
      created_at: 1000,
      decided_at: 1200,
      dispatched_at: 1300,
      settled_at: 1500,
      state: 'denied',
      intent: {
        server_id: 'private-server',
        original_name: 'private-tool',
        location: { kind: 'device' },
        source: {
          runtime: 'pi-coding-agent',
          business_turn_id: 'private-turn',
          tool_call_id: 'private-tool-call',
        },
      },
    } as unknown as import('../src/personal-agent/mcp-approval-store.js').McpApproval;
    tracer.mcpReceipt(receipt, 'decision');
    await tracer.flush();
    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const text = JSON.stringify(spans[0]!.attributes);
    expect(text).toContain('coding');
    expect(text).toContain('denied');
    expect(text).not.toContain('generation_task_id');
    expect(text).not.toContain('tool_task_id');
    expect(text).not.toContain('private-turn');
    expect(text).not.toContain('private-tool-call');
  } finally {
    await tracer.close();
  }
});
