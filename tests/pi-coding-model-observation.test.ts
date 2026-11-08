import { expect, test, vi } from 'vitest';
import { PiRuntimeSession } from '../container/agent-runner/src/runtime/pi/pi-session.js';

test('Coding SDK observation preserves the original stream and does not include content', async () => {
  let resolveResult!: (value: { stopReason: string; content: string }) => void;
  const result = new Promise<{ stopReason: string; content: string }>(
    (resolve) => {
      resolveResult = resolve;
    },
  );
  const stream = { result: () => result };
  const original = vi.fn(() => stream);
  const native = {
    sessionId: 'session-fixture',
    agent: { streamFunction: original },
    subscribe: () => () => {},
    dispose: vi.fn(),
  };
  const session = new PiRuntimeSession(native as never);
  const events: unknown[] = [];
  session.subscribe((event) => events.push(event));
  const returned = await native.agent.streamFunction();
  expect(returned).toBe(stream);
  expect(original).toHaveBeenCalledOnce();
  resolveResult({ stopReason: 'stop', content: 'PRIVATE MODEL ANSWER' });
  await result;
  await Promise.resolve();
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    type: 'model_observation',
    phase: 'start',
  });
  expect(events[1]).toMatchObject({
    type: 'model_observation',
    phase: 'end',
    state: 'completed',
  });
  expect((events[0] as { callId: string }).callId).toBe(
    (events[1] as { callId: string }).callId,
  );
  expect(JSON.stringify(events)).not.toContain('PRIVATE MODEL ANSWER');
  session.dispose();
  expect(native.agent.streamFunction).toBe(original);
});

test('Coding SDK observation preserves synchronous failures and isolates listener errors', () => {
  const failure = new Error('provider failure');
  const original = vi.fn(() => {
    throw failure;
  });
  const native = {
    sessionId: 'session-fixture',
    agent: { streamFunction: original },
    subscribe: () => () => {},
    dispose: vi.fn(),
  };
  const session = new PiRuntimeSession(native as never);
  session.subscribe(() => {
    throw new Error('observer failure');
  });
  expect(() => native.agent.streamFunction()).toThrow(failure);
  session.dispose();
  expect(native.agent.streamFunction).toBe(original);
});

test('Coding SDK observation records rejected stream setup without replacing the rejection', async () => {
  const failure = new Error('upstream rejected');
  const original = vi.fn(() => Promise.reject(failure));
  const native = {
    sessionId: 'session-fixture',
    agent: { streamFunction: original },
    subscribe: () => () => {},
    dispose: vi.fn(),
  };
  const session = new PiRuntimeSession(native as never);
  const events: unknown[] = [];
  session.subscribe((event) => events.push(event));
  await expect(native.agent.streamFunction()).rejects.toBe(failure);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ phase: 'end', state: 'error' });
  expect(JSON.stringify(events)).not.toContain('upstream rejected');
  session.dispose();
});
