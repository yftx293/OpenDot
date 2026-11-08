import { expect, test } from 'vitest';
import { QueueCommandSchema } from '../src/personal-agent/queue-control.js';
import { parseQueueCommand } from '../src/personal-agent/queue-control-core.js';

test('independent Workers wire parser preserves the existing product schema and canonical control receipt bytes', () => {
  const digest = 'a'.repeat(64);
  const valid: Record<string, unknown>[] = [
    {
      action: 'edit',
      content: '  edited\n',
      submissionId: 1,
      expectedQueueDigest: digest,
    },
    { action: 'cancel', submissionId: 1, expectedQueueDigest: digest },
    { action: 'steer', submissionId: 1, expectedQueueDigest: digest },
    { action: 'abort', taskId: 2, expectedQueueDigest: digest },
    { action: 'reorder', submissionIds: [], expectedQueueDigest: digest },
    { action: 'reorder', submissionIds: [2, 1], expectedQueueDigest: digest },
    {
      action: 'edit',
      content: 'x'.repeat(16000),
      submissionId: Number.MAX_SAFE_INTEGER,
      expectedQueueDigest: digest,
    },
    {
      action: 'reorder',
      submissionIds: Array.from({ length: 500 }, (_, i) => i + 1),
      expectedQueueDigest: digest,
    },
  ];
  const candidates: unknown[] = [null, [], {}, 'abort', ...valid];
  for (const command of valid) {
    candidates.push(
      { ...command, extra: true },
      { ...command, expectedQueueDigest: 'A'.repeat(64) },
      { ...command, expectedQueueDigest: 4 },
    );
    for (const key of Object.keys(command)) {
      const missing = { ...command };
      delete missing[key];
      candidates.push(missing);
    }
  }
  for (const n of [
    null,
    '1',
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    candidates.push(
      { action: 'cancel', submissionId: n, expectedQueueDigest: digest },
      { action: 'abort', taskId: n, expectedQueueDigest: digest },
      { action: 'reorder', submissionIds: [n], expectedQueueDigest: digest },
    );
  }
  candidates.push(
    {
      action: 'edit',
      submissionId: 1,
      expectedQueueDigest: digest,
      content: ' '.repeat(5),
    },
    {
      action: 'edit',
      submissionId: 1,
      expectedQueueDigest: digest,
      content: 'x'.repeat(16001),
    },
    { action: 'reorder', expectedQueueDigest: digest, submissionIds: Array(1) },
    {
      action: 'reorder',
      expectedQueueDigest: digest,
      submissionIds: Array.from({ length: 501 }, () => 1),
    },
  );
  for (const input of candidates) {
    const product = QueueCommandSchema.safeParse(input);
    let wire: ReturnType<typeof parseQueueCommand> | undefined;
    try {
      wire = parseQueueCommand(input);
    } catch {
      /* Both boundaries must reject. */
    }
    expect(wire !== undefined, JSON.stringify(input)).toBe(product.success);
    if (product.success)
      expect(JSON.stringify(wire)).toBe(JSON.stringify(product.data));
  }
});
