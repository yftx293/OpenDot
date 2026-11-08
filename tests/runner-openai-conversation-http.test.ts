import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { POLL_INTERVAL } from '../src/config.js';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';

test('ordinary Dot conversations use OpenAI Completions and retain the next turn', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const dot = await f.json<{ profile: { id: string }; jid: string }>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Protocol verification',
        avatar_shape: 'clover',
        avatar_color: '#10b981',
        identity_prompt: '',
      }),
    );
    for (const expected of [
      'OPENAI_CONVERSATION_ONE',
      'OPENAI_CONVERSATION_TWO',
    ]) {
      f.setModel(() => ({ text: expected }));
      await f.json(
        await f.call('/api/messages', 'POST', {
          chatJid: dot.jid,
          expectedAgentProfileId: dot.profile.id,
          content: 'Reply with ' + expected,
        }),
      );
      await waitFor(async () => {
        const page = await f.json<{ messages: { content: string }[] }>(
          await f.call(
            '/api/groups/' + encodeURIComponent(dot.jid) + '/messages',
          ),
        );
        return page.messages.some(
          (message) => message.content.trim() === expected,
        );
      }, 60000);
    }
    expect(f.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain(
      'OPENAI_CONVERSATION_ONE',
    );
    expect(f.diagnostics()).not.toContain('Container exited');
  } finally {
    await f.dispose();
  }
}, 180000);

test('a warm Host Pi runner surfaces an HTTP 429 once and does not replay it after restart', async () => {
  const f = await botHandoffHttpFixture();
  try {
    const dot = await f.json<{ profile: { id: string }; jid: string }>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Throttling verification',
        avatar_shape: 'clover',
        avatar_color: '#10b981',
        identity_prompt: '',
      }),
    );
    f.setModel(() => ({
      error: {
        status: 429,
        code: 'WorkBuddy AI: usage exceeds frequency limit',
      },
    }));
    await f.json(
      await f.call('/api/messages', 'POST', {
        chatJid: dot.jid,
        expectedAgentProfileId: dot.profile.id,
        content: 'THROTTLE_ACCEPTANCE_INPUT',
      }),
    );
    const messages = async () =>
      (
        await f.json<{ messages: { id: string; content: string }[] }>(
          await f.call(
            '/api/groups/' + encodeURIComponent(dot.jid) + '/messages',
          ),
        )
      ).messages;
    const isProviderFailureNotice = (content: string) =>
      content.includes('429') && content.includes('WorkBuddy AI');
    await waitFor(
      async () =>
        (await messages()).some((message) =>
          isProviderFailureNotice(message.content),
        ),
      60000,
    );
    await waitFor(
      () =>
        /Host Agent (?:terminated by signal|killed before producing any output|exited with error|completed)/.test(
          f.diagnostics(),
        ),
      10000,
    );
    const before = await messages();
    expect(
      before.filter((message) => isProviderFailureNotice(message.content)),
    ).toHaveLength(1);
    expect(
      before.some((message) => message.content.includes('额度已用尽')),
    ).toBe(false);
    expect(
      before.filter(
        (message) => message.content === 'THROTTLE_ACCEPTANCE_INPUT',
      ),
    ).toHaveLength(1);
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.length).toBeLessThanOrEqual(4);
    const attempts = f.requests.length;
    expect(f.diagnostics()).toContain('Provider failure surfaced to user');

    // Reopen the existing conversation and reconstruct the actual backend. A
    // terminal error must not silently re-admit the already processed input.
    await f.stop();
    await f.start();
    await messages();
    // Observe more than two normal message-poll intervals after recovery.
    await delay(2 * POLL_INTERVAL + 100);
    expect((await messages()).map((message) => message.id).sort()).toEqual(
      before.map((message) => message.id).sort(),
    );
    expect(f.requests).toHaveLength(attempts);
  } finally {
    await f.dispose();
  }
}, 180000);
