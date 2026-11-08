import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { expect, test } from 'vitest';
import { CodingToolObservationTracker } from '../src/personal-agent/coding-tool-observation.js';
import { HostObservability } from '../src/personal-agent/host-observability.js';

const identity = {
  ownerId: 'owner-secret',
  sessionId: 'session-one',
  inputId: 'input-private',
};
const start = {
  eventType: 'tool_use_start' as const,
  toolUseId: 'call-private',
  toolName: 'private tool',
  toolInputSummary: 'private args',
};
const end = {
  eventType: 'tool_use_end' as const,
  toolUseId: 'call-private',
  toolIsError: true,
  toolResult: 'private result',
};

test('matches exact sessions and input, ignores duplicates, stale and synthetic events', () => {
  const receipts: unknown[] = [];
  const tracker = new CodingToolObservationTracker((value) =>
    receipts.push(value),
  );
  tracker.accept(identity, start, 1000);
  tracker.accept({ ...identity, sessionId: 'session-two' }, end, 1050);
  tracker.accept({ ...identity, inputId: 'input-two' }, end, 1050);
  tracker.accept(identity, { ...end, isSynthetic: true }, 1050);
  expect(receipts).toHaveLength(0);
  tracker.accept(identity, end, 1100);
  tracker.accept(identity, end, 1101);
  expect(receipts).toEqual([
    {
      ...identity,
      callId: 'call-private',
      startedAt: 1000,
      endedAt: 1100,
      state: 'error',
    },
  ]);
  tracker.accept(identity, { ...start, toolUseId: 'unknown-call' }, 2000);
  tracker.accept(
    identity,
    { eventType: 'tool_use_end', toolUseId: 'unknown-call' },
    2001,
  );
  expect(receipts[1]).toMatchObject({ state: 'unknown' });
  tracker.accept(identity, { ...start, toolUseId: 'expired' }, 3000);
  tracker.accept(identity, { ...end, toolUseId: 'expired' }, 3603001);
  expect(receipts).toHaveLength(2);
});

test('exported Coding span contains metadata only and uses observed timestamps', async () => {
  const exporter = new InMemorySpanExporter();
  const observer = new HostObservability({
    publicKey: 'fixture',
    secretKey: 'fixture',
    baseUrl: 'https://example.test/',
    installationId: randomUUID(),
    sampleRate: 1,
    exporter,
  });
  const tracker = new CodingToolObservationTracker((receipt) =>
    observer.codingTool(receipt),
  );
  try {
    tracker.accept(identity, start, 1000);
    tracker.accept(identity, end, 1250);
    await observer.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const payload = JSON.stringify(spans[0]!.attributes);
    for (const secret of [
      'owner-secret',
      'input-private',
      'call-private',
      'private tool',
      'private args',
      'private result',
    ])
      expect(payload).not.toContain(secret);
    expect(payload).toContain('host_observed_stream');
    expect(payload).toContain('error');
  } finally {
    await observer.close();
  }
});

test('terminal input records unfinished tools once without affecting another session', () => {
  const receipts: unknown[] = [];
  const tracker = new CodingToolObservationTracker((value) =>
    receipts.push(value),
  );
  const other = { ...identity, sessionId: 'another-session' };
  tracker.accept(identity, start, 1000);
  tracker.accept(other, start, 1001);
  tracker.finishInput(identity, 1100);
  tracker.finishInput(identity, 1101);
  tracker.accept(identity, end, 1102);
  expect(receipts).toEqual([
    {
      ...identity,
      callId: 'call-private',
      startedAt: 1000,
      endedAt: 1100,
      state: 'incomplete',
    },
  ]);
  tracker.accept(other, end, 1200);
  expect(receipts[1]).toMatchObject({
    sessionId: 'another-session',
    state: 'error',
  });
});
