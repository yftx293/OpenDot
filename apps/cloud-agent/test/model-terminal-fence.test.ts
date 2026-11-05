import { expect, test } from 'vitest';
import { recoverableModelFetch } from '../src/model-recovery';

const host = {
  admit: async () => {},
  park: async (): Promise<never> => {
    throw new Error('PARKED');
  },
};
const response = (body: string) =>
  new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });

test('a DONE sentinel without a completed model choice parks the invocation', async () => {
  const request = new Request('https://synthetic.invalid/v1');
  const result = await recoverableModelFetch(
    request,
    async () =>
      response(
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      ),
    host,
  );
  await expect(result.text()).rejects.toThrow('PARKED');
});

test('a complete finish reason can end without a DONE sentinel', async () => {
  const request = new Request('https://synthetic.invalid/v1');
  const result = await recoverableModelFetch(
    request,
    async () =>
      response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
    host,
  );
  expect(await result.text()).toContain('"finish_reason":"stop"');
});

test.each([
  { choices: [{ finish_reason: '' }] },
  { choices: [{ finish_reason: null }, { finish_reason: 'stop' }] },
])(
  'only the first non-empty finish reason completes a model response',
  async (chunk) => {
    const request = new Request('https://synthetic.invalid/v1');
    const result = await recoverableModelFetch(
      request,
      async () =>
        response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`),
      host,
    );
    await expect(result.text()).rejects.toThrow('PARKED');
  },
);

test('abort after a finish frame cannot be mistaken for a clean EOF', async () => {
  const controller = new AbortController();
  const request = new Request('https://synthetic.invalid/v1', {
    signal: controller.signal,
  });
  const stream = new ReadableStream<Uint8Array>({
    start(writer) {
      writer.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        ),
      );
    },
  });
  const result = await recoverableModelFetch(
    request,
    async () =>
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    host,
  );
  const reader = result.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  controller.abort(new Error('STOPPED'));
  await expect(reader.read()).rejects.toThrow('STOPPED');
});
