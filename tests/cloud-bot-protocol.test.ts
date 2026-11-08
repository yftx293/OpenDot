import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  BindingSchema,
  ProvisionSchema,
} from '../apps/cloud-agent/src/protocol.js';
import {
  CloudHandoffBindingSchema,
  CloudHandoffProgressSchema,
} from '../src/bot-groups/cloud-protocol.js';
const binding = () => ({
  handoff_id: randomUUID(),
  group_id: randomUUID(),
  grant_digest: 'a'.repeat(64),
});
test('Cloud Handoff proof is explicit and cannot smuggle workspace/goal/runtime ownership fields', () => {
  const value = binding();
  expect(CloudHandoffBindingSchema.parse(value)).toEqual(value);
  expect(
    CloudHandoffBindingSchema.safeParse({ ...value, grant_digest: 'changed' })
      .success,
  ).toBe(false);
  for (const extra of [
    { workspace_jid: 'web:foreign' },
    { goal_id: randomUUID() },
    { runtime_id: randomUUID() },
    { owner_user_id: 'forged' },
  ])
    expect(
      CloudHandoffBindingSchema.safeParse({ ...value, ...extra }).success,
    ).toBe(false);
});
test('bounded Cloud progress accepts native run and ordered revision only, never caller-provided final answers or approvals', () => {
  const value = {
    handoff: binding(),
    revision: 1,
    control_revision: 0,
    frame: {
      runtime_state: 'active',
      run_task_id: 3,
      queue_digest: 'b'.repeat(64),
      partial_text: 'partial',
      tools: [{ name: 'inspect_text', status: 'running' }],
    },
  };
  expect(CloudHandoffProgressSchema.parse(value)).toEqual(value);
  for (const extra of [
    { result_message_id: randomUUID() },
    { answer_entry_id: 8 },
    { approval: { state: 'approved' } },
    { state: 'completed' },
  ])
    expect(
      CloudHandoffProgressSchema.safeParse({ ...value, ...extra }).success,
    ).toBe(false);
  expect(
    CloudHandoffProgressSchema.safeParse({ ...value, revision: 0 }).success,
  ).toBe(false);
  expect(
    CloudHandoffProgressSchema.safeParse({
      ...value,
      frame: { ...value.frame, partial_text: 'x'.repeat(4001) },
    }).success,
  ).toBe(false);
  expect(
    CloudHandoffProgressSchema.safeParse({
      ...value,
      frame: { ...value.frame, tools: Array(21).fill(value.frame.tools[0]) },
    }).success,
  ).toBe(false);
});

test('Node and standalone Worker parse the same marker while Worker admission rejects missing authority, undeclared tools and Goal-owner aliases', () => {
  const marker = binding(),
    value = {
      version: 1 as const,
      owner_user_id: 'alice',
      workspace_jid: 'web:alice',
      session_id: randomUUID(),
      runtime_id: randomUUID(),
      config_fingerprint: 'a'.repeat(64),
      provider_id: 'fixture',
      model_id: 'fixture',
      instructions: '',
      max_model_steps: 4,
      deadline_at: Date.now() + 60000,
      execution_authority: 'miniclaw-product' as const,
      tool_capabilities: ['inspect_text'],
      bot_handoff: marker,
    };
  expect(BindingSchema.parse(value).bot_handoff).toEqual(
    CloudHandoffBindingSchema.parse(marker),
  );
  expect(ProvisionSchema.safeParse(value).success).toBe(true);
  expect(
    ProvisionSchema.safeParse({ ...value, execution_authority: undefined })
      .success,
  ).toBe(false);
  expect(
    ProvisionSchema.safeParse({ ...value, tool_capabilities: undefined })
      .success,
  ).toBe(false);
  expect(
    ProvisionSchema.safeParse({
      ...value,
      tool_capabilities: ['read_personal_memory'],
    }).success,
  ).toBe(false);
  expect(
    BindingSchema.safeParse({
      ...value,
      bot_handoff: { ...marker, workspace_jid: 'web:foreign' },
    }).success,
  ).toBe(false);
  const goal_id = randomUUID(),
    ordinaryGoal = { ...value, bot_handoff: undefined, goal_id },
    execution = {
      version: 1,
      goal_id,
      session_id: value.session_id,
      runtime_id: value.runtime_id,
      run_id: randomUUID(),
      task_id: randomUUID(),
      context_digest: 'b'.repeat(64),
      snapshot_digest: 'c'.repeat(64),
      max_model_steps: 12,
      issued_at: Date.now(),
      deadline_at: value.deadline_at,
    };
  expect(
    ProvisionSchema.safeParse({ binding: ordinaryGoal, execution }).success,
  ).toBe(true);
  expect(
    ProvisionSchema.safeParse({
      binding: { ...ordinaryGoal, bot_handoff: marker },
      execution,
    }).success,
  ).toBe(false);
});

test('Node and standalone Worker canonicalize the same input-bound progress envelope and reject Goal/approval/final-result authority', async () => {
  const { CloudHandoffProgressDeliverySchema } =
    await import('../src/bot-groups/cloud-protocol.js');
  const { HandoffProgressDeliverySchema } =
    await import('../apps/cloud-agent/src/handoff-protocol.js');
  const value = {
    input: {
      request_id: randomUUID(),
      content: 'original context',
      when_busy: 'followUp',
      product_receipt_digest: 'a'.repeat(64),
    },
    native: { submission_id: 3, status: 'placed' },
    progress: {
      handoff: binding(),
      revision: 4,
      control_revision: 2,
      frame: {
        runtime_state: 'recovering',
        run_task_id: 9,
        queue_digest: 'b'.repeat(64),
        partial_text: 'partial',
        tools: [],
      },
    },
  };
  for (const candidate of [
    value,
    Object.fromEntries(Object.entries(value).reverse()),
  ])
    expect(
      JSON.stringify(CloudHandoffProgressDeliverySchema.parse(candidate)),
    ).toBe(JSON.stringify(HandoffProgressDeliverySchema.parse(candidate)));
  for (const candidate of [
    { ...value, result: { text: 'forged completion' } },
    {
      ...value,
      input: { ...value.input, execution: { goal_id: randomUUID() } },
    },
    { ...value, native: { ...value.native, submission_id: null } },
    { ...value, progress: { ...value.progress, control_revision: -1 } },
    {
      ...value,
      progress: { ...value.progress, approval: { state: 'approved' } },
    },
  ]) {
    expect(
      CloudHandoffProgressDeliverySchema.safeParse(candidate).success,
    ).toBe(false);
    expect(HandoffProgressDeliverySchema.safeParse(candidate).success).toBe(
      false,
    );
  }
});
