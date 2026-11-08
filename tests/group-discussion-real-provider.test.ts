import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import OpenAI from 'openai';
import {
  discussionRealProvider,
  redactDiscussionEvidence,
  readDiscussionModelCredentials,
  type RealRequestBinding,
} from '../scripts/lib/discussion-real-provider.js';
const binding: RealRequestBinding = {
  sessionId: 'native-session',
  requestId: 'original-request',
  groupId: 'group',
  frozenInputMatches: true,
  publicReads: [],
  userMessageIds: [],
  containsIsolationCanary: false,
};

test.each(['complete', 'partial', 'finish-only', 'done-only'] as const)(
  'actual SDK cleanup distinguishes complete SSE from interrupted or malformed streams: %s',
  async (mode) => {
    const packet = (finish: string | null) =>
      `data: ${JSON.stringify({ id: 'observer-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: 'ACTUAL_SDK_TEXT' }, finish_reason: finish }] })}\n\n`;
    const complete = mode === 'complete';
    const p = await discussionRealProvider({
      upstream: {
        baseUrl: 'https://provider.invalid/v1',
        model: 'test-model',
        apiKey: 'test-secret',
      },
      bind: () => binding,
      limit: 1,
      forward: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const text =
                packet(complete || mode === 'finish-only' ? 'stop' : null) +
                (complete || mode === 'done-only' ? 'data: [DONE]\n\n' : '');
              controller.enqueue(new TextEncoder().encode(text));
              // Hold HTTP open after SSE termination, as a real provider can do.
              // Its response is cancelled only when the actual SDK closes its side.
              init!.signal!.addEventListener(
                'abort',
                () => {
                  controller.error(
                    new DOMException('stream cancelled', 'AbortError'),
                  );
                },
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    try {
      const client = new OpenAI({
        apiKey: p.token,
        baseURL: p.baseUrl,
        maxRetries: 0,
      });
      const stream = await client.chat.completions.create({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Test the observer transport.' }],
        stream: true,
      });
      let text = '';
      for await (const frame of stream) {
        text += frame.choices[0]?.delta.content ?? '';
        if (mode === 'partial' || mode === 'finish-only') break;
      }
      expect(text).toBe('ACTUAL_SDK_TEXT');
      await expect.poll(() => p.traces[0]?.finishedAt).toBeTypeOf('number');
      expect(p.traces[0].status).toBe(200);
      expect(p.traces[0].publicOutput).toBe(text);
      expect(p.traces[0].aborted).toBe(true);
      if (complete) {
        expect(p.traces[0].errorCode).toBeUndefined();
        expect(p.traces[0]).toMatchObject({
          completionSentinel: true,
          finishReason: 'stop',
          closedAfterCompletion: true,
        });
      } else {
        expect(p.traces[0].errorCode).toBe('NATIVE_REQUEST_ABORTED');
        expect(p.traces[0].closedAfterCompletion).toBe(false);
      }
      expect(p.traces).toHaveLength(1);
      expect(p.rejected).toBe(0);
    } finally {
      await p.close();
    }
  },
  8000,
);
test('observer preserves real SDK bytes, application session headers and streamed usage without logging secrets', async () => {
  let seenBody = '',
    seenSession = '',
    seenKey = '';
  const forward: typeof fetch = async (_url, init) => {
    seenBody = init!.body as string;
    const headers = new Headers(init!.headers);
    seenSession = headers.get('x-opencode-session')!;
    seenKey = headers.get('authorization')!;
    return new Response(
      'data: {"choices":[{"delta":{"content":"REAL_TEST_DELTA"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":3,"total_tokens":24}}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const p = await discussionRealProvider({
    upstream: {
      baseUrl: 'https://opencode.ai/fixture-provider/v1',
      model: 'test-model',
      apiKey: 'test-upstream-secret',
    },
    bind: () => binding,
    limit: 1,
    forward,
  });
  try {
    const body = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Original actual SDK input.' }],
      temperature: 0.7,
      max_tokens: 37,
      stream_options: { include_usage: true },
    });
    const r = await fetch(p.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + p.token },
      body,
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('REAL_TEST_DELTA');
    expect(seenBody).toBe(body);
    expect(seenSession).toBe('native-session');
    expect(seenKey).toBe('Bearer test-upstream-secret');
    expect(p.traces[0].usage).toEqual({ input: 21, output: 3, total: 24 });
    expect(p.traces[0].publicOutput).toBe('REAL_TEST_DELTA');
    expect(p.traces[0].temperature).toBe(0.7);
    expect(p.traces[0].maxTokens).toBe(37);
    expect(JSON.stringify(p.traces)).not.toContain('test-upstream-secret');
    const denied = await fetch(p.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + p.token },
      body,
    });
    expect(denied.status).toBe(429);
    expect(p.traces).toHaveLength(1);
  } finally {
    await p.close();
  }
});
test('invalid bearer, model or unfrozen source never forwards a model request', async () => {
  let calls = 0;
  const p = await discussionRealProvider({
    upstream: {
      baseUrl: 'https://opencode.ai/fixture-provider/v1',
      model: 'test-model',
      apiKey: 'private',
    },
    bind: () => ({ ...binding, frozenInputMatches: false }),
    limit: 2,
    forward: async () => {
      calls++;
      return new Response('forbidden');
    },
  });
  try {
    const send = (token: string, model = 'test-model') =>
      fetch(p.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: JSON.stringify({ model, messages: [] }),
      });
    expect((await send('wrong')).status).toBe(403);
    expect((await send(p.token, 'another')).status).toBe(502);
    expect((await send(p.token)).status).toBe(502);
    expect(calls).toBe(0);
    expect(p.traces).toHaveLength(0);
    expect(p.rejected).toBe(3);
  } finally {
    await p.close();
  }
});
test('evidence removes configured secrets, model identity, endpoints and private paths', () => {
  const value = redactDiscussionEvidence(
    'api=test-secret model=test-model https://private.example/v1 /Users/person/private.txt oc_sk_sensitive_value',
    ['test-secret', 'test-model'],
  );
  expect(value).not.toMatch(
    /test-secret|test-model|private.example|person\/|oc_sk_/,
  );
});

test('malformed private configuration never exposes the JSON credential fragment in an error', () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'miniclaw-private-config-'),
  );
  const file = path.join(dir, 'private.json');
  try {
    fs.writeFileSync(file, '{"apiKey":"MUST_NOT_LEAK", broken');
    try {
      readDiscussionModelCredentials(file);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toBe('Error: PRIVATE_MODEL_CONFIGURATION_INVALID');
      expect(String(error)).not.toContain('MUST_NOT_LEAK');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
