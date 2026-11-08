import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { expect, test, vi } from 'vitest';
import type { AssistantMessage, ProviderStreams } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { meteredModelApi } from '../src/personal-agent/metered-model-api.js';
function fixture() {
  const source = new AssistantMessageEventStream();
  const model: Parameters<ProviderStreams['stream']>[0] = {
    id: 'admission',
    name: 'Admission',
    provider: 'fixture',
    api: 'openai-completions',
    reasoning: false,
    input: ['text'],
    baseUrl: 'http://127.0.0.1/v1',
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Only final output' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 31,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 38,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const call = vi.fn(() => source);
  const api = { stream: call, streamSimple: call } as ProviderStreams;
  return { source, model, message, call, api };
}
test('queued admission does not invoke a provider, then dispatches once and settles the actual terminal usage', async () => {
  const f = fixture();
  let release!: (value: any) => void;
  const waiting = new Promise<any>((resolve) => {
    release = resolve;
  });
  const dispatch = vi.fn(),
    settle = vi.fn();
  const output = meteredModelApi(
    f.api,
    () => {},
    () => waiting,
  ).stream(f.model, normalizeContext({ messages: [] }));
  expect(f.call).not.toHaveBeenCalled();
  release({ dispatch, settle });
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
  expect(dispatch).toHaveBeenCalledTimes(1);
  f.source.push({ type: 'start', partial: f.message });
  f.source.push({ type: 'done', reason: 'stop', message: f.message });
  f.source.end();
  expect((await output.result()).stopReason).toBe('stop');
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls[0][0]).toMatchObject({
    kind: 'done',
    usage: { totalTokens: 38 },
  });
});
test('cancellation before an awaited permit is used does not start a provider or charge a dispatch', async () => {
  const f = fixture(),
    cancel = new AbortController();
  let release!: (value: any) => void;
  const waiting = new Promise<any>((resolve) => {
    release = resolve;
  });
  const dispatch = vi.fn(),
    settle = vi.fn();
  const output = meteredModelApi(
    f.api,
    () => {},
    () => waiting,
  ).stream(f.model, normalizeContext({ messages: [] }), {
    signal: cancel.signal,
  });
  cancel.abort();
  release({ dispatch, settle });
  expect((await output.result()).stopReason).toBe('aborted');
  expect(f.call).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle.mock.calls[0][0].kind).toBe('aborted');
});

test('an accounting callback failure is explicit uncertainty and cannot publish a successful final or settle twice', async () => {
  const f = fixture(),
    settle = vi.fn(() => {
      throw new Error('Synthetic accounting storage unavailable');
    });
  const output = meteredModelApi(
    f.api,
    () => {},
    () => ({ dispatch: () => {}, settle }),
  ).stream(f.model, normalizeContext({ messages: [] }));
  f.source.push({ type: 'done', reason: 'stop', message: f.message });
  f.source.end();
  const result = await output.result();
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toBe('MODEL_ACCOUNTING_UNCERTAIN');
  expect(settle).toHaveBeenCalledTimes(1);
});
