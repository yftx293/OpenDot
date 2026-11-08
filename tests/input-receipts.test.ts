import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { pendingInputRequest } from '../web/src/utils/input-receipts.js';
afterEach(() => vi.unstubAllGlobals());
test('keeps unknown input keys and hashes every execution parameter without storing message text', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const owner = randomUUID();
  const payload = {
    content: 'private draft',
    followUpBehavior: 'queue',
    agentId: 'a',
  };
  const first = await pendingInputRequest(owner, payload);
  expect((await pendingInputRequest(owner, payload)).requestId).toBe(
    first.requestId,
  );
  expect(
    (
      await pendingInputRequest(owner, {
        ...payload,
        followUpBehavior: 'steer',
      })
    ).requestId,
  ).not.toBe(first.requestId);
  expect([...stored.values()].join('')).not.toContain('private draft');
});
test('a late acknowledgement cannot clear a newer input when persistent storage fails', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('disabled');
    },
    setItem: () => {
      throw new Error('disabled');
    },
  });
  const owner = randomUUID();
  const first = await pendingInputRequest(owner, { content: 'same text' });
  first.acknowledge();
  const newer = await pendingInputRequest(owner, { content: 'same text' });
  expect(newer.requestId).not.toBe(first.requestId);
  first.acknowledge();
  expect(
    (await pendingInputRequest(owner, { content: 'same text' })).requestId,
  ).toBe(newer.requestId);
});
