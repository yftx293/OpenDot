import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import * as node from '../src/personal-agent/cloud-device-wire.js';
import * as worker from '../apps/cloud-agent/src/device-protocol.js';
const hash = 'a'.repeat(64);
const intent = {
  id: 'task:2',
  conversation_id: 1,
  task_id: 2,
  generation_task_id: 1,
  call_id: 'original',
  name: 'read_device_file',
  parameters: { node_id: randomUUID(), path: 'research.txt' },
  parameters_digest: hash,
};
const receipt = {
  request_id: randomUUID(),
  owner_user_id: 'owner',
  workspace_jid: 'web:owner',
  goal_id: randomUUID(),
  run_id: randomUUID(),
  handoff_id: randomUUID(),
  cloud_session_id: randomUUID(),
  node_id: intent.parameters.node_id,
  path: intent.parameters.path,
  operation_digest: hash,
  deadline_at: Date.now() + 60000,
};
test('the standalone Worker and Node validators produce identical canonical wire/checkpoint bytes and reject malformed scope', () => {
  const cases = [
    { phase: 'confirm', receipt, result_digest: hash },
    { phase: 'status', receipt },
    { phase: 'propose' },
    { phase: 'execute', receipt },
    { phase: 'confirm', receipt: { ...receipt, cloud_session_id: 'other' } },
    { phase: 'confirm', result_digest: 'invalid' },
    { phase: 'probe', undeclared: true },
  ];
  for (const extra of cases) {
    const input = { ...intent, ...extra },
      a = node.CloudDeviceRequestSchema.safeParse(input),
      b = worker.CloudDeviceRequestSchema.safeParse(input);
    expect(a.success).toBe(b.success);
    if (a.success && b.success)
      expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  }
  for (const output of [
    { identity: receipt, state: 'waiting_for_permission' },
    {
      identity: receipt,
      state: 'completed',
      result: { ok: true, content: 'bytes', content_digest: hash },
    },
    {
      identity: receipt,
      state: 'completed',
      result: { ok: true, content: 'x'.repeat(65537), content_digest: hash },
    },
    {
      identity: receipt,
      state: 'completed',
      result: { ok: true, content: '😀'.repeat(20000), content_digest: hash },
    },
  ]) {
    const a = node.CloudDeviceResponseSchema.safeParse(output),
      b = worker.CloudDeviceResponseSchema.safeParse(output);
    expect(a.success).toBe(b.success);
    if (a.success && b.success)
      expect(JSON.stringify(a.data)).toBe(JSON.stringify(b.data));
  }
});
