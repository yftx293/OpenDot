import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-execution-wire-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const { CloudExecutionRefSchema, CloudExecutionGrantSchema } =
  await import('../src/personal-agent/product-runtime-store.js');
const { ExecutionRefSchema, ExecutionGrantSchema } =
  await import('../apps/cloud-agent/src/execution-protocol.js');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const ref = {
  goal_id: '10000000-0000-4000-8000-000000000001',
  run_id: '10000000-0000-4000-8000-000000000002',
  context_digest: 'a'.repeat(64),
};
const grant = {
  ...ref,
  version: 1,
  session_id: '10000000-0000-4000-8000-000000000003',
  runtime_id: '10000000-0000-4000-8000-000000000004',
  task_id: '10000000-0000-4000-8000-000000000005',
  snapshot_digest: 'b'.repeat(64),
  max_model_steps: 12,
  issued_at: 1_792_300_000_000,
  deadline_at: 1_792_386_400_000,
};
test('Node and independent Worker grant parsers accept the same strict protocol and canonicalize identical bytes', () => {
  for (const value of [
    grant,
    Object.fromEntries(Object.entries(grant).reverse()),
  ]) {
    expect(JSON.stringify(ExecutionGrantSchema.parse(value))).toBe(
      JSON.stringify(CloudExecutionGrantSchema.parse(value)),
    );
  }
  for (const field of Object.keys(grant)) {
    const missing = { ...grant } as Record<string, unknown>;
    delete missing[field];
    expect(ExecutionGrantSchema.safeParse(missing).success, field).toBe(false);
    expect(CloudExecutionGrantSchema.safeParse(missing).success, field).toBe(
      false,
    );
  }
  for (const value of [
    null,
    [],
    { ...grant, extra: true },
    { ...grant, version: 2 },
    { ...grant, max_model_steps: 24 },
    { ...grant, max_model_steps: '12' },
    { ...grant, issued_at: -1 },
    { ...grant, issued_at: 1.5 },
    { ...grant, deadline_at: grant.issued_at },
    { ...grant, deadline_at: grant.deadline_at + 1 },
    { ...grant, snapshot_digest: 'b'.repeat(63) },
    { ...grant, context_digest: 'A'.repeat(64) },
    ...['goal_id', 'run_id', 'session_id', 'runtime_id', 'task_id'].map(
      (field) => ({ ...grant, [field]: 'untrusted/id' }),
    ),
  ]) {
    expect(ExecutionGrantSchema.safeParse(value).success).toBe(false);
    expect(CloudExecutionGrantSchema.safeParse(value).success).toBe(false);
  }
});
test('execution references never accept a complete grant or mutable caller metadata as extra authority', () => {
  expect(JSON.stringify(ExecutionRefSchema.parse(ref))).toBe(
    JSON.stringify(CloudExecutionRefSchema.parse(ref)),
  );
  for (const value of [
    grant,
    { ...ref, lease_token: 2 },
    { ...ref, owner_user_id: 'other' },
    { ...ref, run_id: 2 },
    { ...ref, context_digest: '' },
  ]) {
    expect(ExecutionRefSchema.safeParse(value).success).toBe(false);
    expect(CloudExecutionRefSchema.safeParse(value).success).toBe(false);
  }
});

test('Node and Worker stop fences retain the exact lease or Goal revision with no caller-selected execution mode', async () => {
  const { CloudStopFenceSchema } =
    await import('../src/personal-agent/cloud-lifecycle.js');
  const { StopFenceSchema } =
    await import('../apps/cloud-agent/src/execution-protocol.js');
  for (const value of [
    {
      kind: 'claim',
      run_id: ref.run_id,
      lease_owner: 'scheduler',
      lease_token: 3,
    },
    { kind: 'goal', goal_id: ref.goal_id, goal_revision: 4 },
    { kind: 'handoff', handoff_id: ref.run_id, handoff_revision: 5 },
    {
      kind: 'group_member',
      run_id: ref.run_id,
      lease_id: ref.goal_id,
      cancel_epoch: 2,
    },
  ]) {
    expect(JSON.stringify(CloudStopFenceSchema.parse(value))).toBe(
      JSON.stringify(StopFenceSchema.parse(value)),
    );
    for (const altered of [
      { ...value, mode: 'active' },
      { ...value, execution: ref },
      { ...value, lease_token: 0 },
      { ...value, goal_revision: -1 },
    ]) {
      expect(CloudStopFenceSchema.safeParse(altered).success).toBe(false);
      expect(StopFenceSchema.safeParse(altered).success).toBe(false);
    }
  }
});
