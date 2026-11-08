import { describe, expect, it, vi } from 'vitest';
import {
  Mem0OperationError,
  Mem0PrivateClient,
  mem0PrivateScope,
} from '../src/mem0-private-client.js';

const scope = mem0PrivateScope({
  installationId: 'install-1',
  environment: 'test',
  ownerUserId: 'owner-1',
  profileId: 'dot-1',
  sessionId: 'private-session-1',
});

describe('Host Mem0 add/search boundary', () => {
  it('uses a private app plus speaker OR filter and discards unverified or cross-Dot results', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            id: 'own',
            memory: 'Private canary',
            score: 0.8,
            app_id: scope.app_id,
            user_id: scope.user_id,
          },
          {
            id: 'other-dot',
            memory: 'Wrong Dot',
            score: 0.9,
            app_id: scope.app_id,
            user_id: 'other-dot',
          },
          { id: 'scope-omitted', memory: 'Unknown', score: 0.7 },
        ],
      }),
    );
    const result = await new Mem0PrivateClient('test-key', send).search({
      scope,
      query: 'What did I say?',
    });
    expect(result).toEqual([
      { id: 'own', memory: 'Private canary', score: 0.8 },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, options] = send.mock.calls[0]!;
    expect(url).toBe('https://api.mem0.ai/v3/memories/search/');
    expect(JSON.parse(String(options?.body))).toEqual({
      query: 'What did I say?',
      filters: {
        AND: [
          { app_id: scope.app_id },
          { OR: [{ user_id: scope.user_id }, { agent_id: scope.agent_id }] },
        ],
      },
      top_k: 5,
    });
    expect(options?.redirect).toBe('error');
  });

  it('rejects contradictory user or agent identifiers while allowing a missing second scope', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            id: 'other-agent',
            memory: 'not ours',
            score: 0.9,
            app_id: scope.app_id,
            user_id: scope.user_id,
            agent_id: 'other-agent',
          },
          {
            id: 'other-user',
            memory: 'not ours',
            score: 0.9,
            app_id: scope.app_id,
            user_id: 'other-user',
            agent_id: scope.agent_id,
          },
          {
            id: 'agent-only',
            memory: 'ours',
            score: 0.8,
            app_id: scope.app_id,
            user_id: null,
            agent_id: scope.agent_id,
          },
          {
            id: 'both',
            memory: 'ours too',
            score: 0.7,
            app_id: scope.app_id,
            user_id: scope.user_id,
            agent_id: scope.agent_id,
          },
        ],
      }),
    );
    const result = await new Mem0PrivateClient('test-key', send).search({
      scope,
      query: 'preference',
      topK: 10,
    });
    expect(result.map((hit) => hit.id)).toEqual(['agent-only', 'both']);
  });

  it('sends only a completed user/assistant pair and treats PENDING as acceptance', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ event_id: 'evt-1', status: 'PENDING' }),
      );
    const outcome = await new Mem0PrivateClient('test-key', send).add({
      scope,
      userText: 'I like tea.',
      answerText: 'I will remember that.',
      turnId: 'input-1',
    });
    expect(outcome).toEqual({ state: 'accepted', eventId: 'evt-1' });
    const [url, options] = send.mock.calls[0]!;
    expect(url).toBe('https://api.mem0.ai/v3/memories/add/');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      ...scope,
      messages: [
        { role: 'user', content: 'I like tea.' },
        { role: 'assistant', content: 'I will remember that.' },
      ],
      metadata: { source: 'opendot-owner-private', turn_id: 'input-1' },
    });
  });

  it('never retries a possibly delivered add after a lost ACK', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('lost ACK'));
    await expect(
      new Mem0PrivateClient('test-key', send).add({
        scope,
        userText: 'I like tea.',
        answerText: 'Understood.',
        turnId: 'input-1',
      }),
    ).rejects.toMatchObject({ kind: 'uncertain' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After seconds and HTTP dates without shortening long delays', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
      for (const [header, seconds] of [
        ['172800', 172800],
        ['Wed, 28 Oct 2026 00:02:00 GMT', 120],
        ['Wed, 28 Oct 2026 00:01:59 GMT', 119],
        ['invalid', undefined],
      ] as const) {
        const send = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, { status: 429, headers: { 'Retry-After': header } }),
        );
        await expect(
          new Mem0PrivateClient('test-key', send).search({ scope, query: 'tea' }),
        ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: seconds });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies credentials, refusal, and rate limits without leaking response bodies', async () => {
    for (const [status, kind] of [
      [401, 'authentication'],
      [400, 'invalid_request'],
      [429, 'rate_limited'],
      [500, 'uncertain'],
    ] as const) {
      const send = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('secret diagnostic', {
          status,
          headers: { 'retry-after': '3' },
        }),
      );
      await expect(
        new Mem0PrivateClient('test-key', send).search({ scope, query: 'tea' }),
      ).rejects.toMatchObject({ kind });
    }
    expect(() => new Mem0PrivateClient('bad\nkey')).toThrow(Mem0OperationError);
  });
});
