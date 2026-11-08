// Validator parity only; successful parsing never grants execution authority.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { CloudMemberToolRequestSchema as nodeSchema } from '../src/bot-groups/member-wire.js';
import { CloudMemberToolRequestSchema as workerSchema } from '../apps/cloud-agent/src/member-protocol.js';
import {
  CloudMemberExecutionSchema as nodeExecution,
  CloudMemberEffectProofSchema as nodeEffect,
  CloudMemberModelProofSchema as nodeModel,
} from '../src/bot-groups/member-wire.js';
import {
  CloudMemberExecutionSchema as workerExecution,
  CloudMemberEffectProofSchema as workerEffect,
  CloudMemberModelProofSchema as workerModel,
} from '../apps/cloud-agent/src/member-protocol.js';

test('member execution and native model proof have strict Node/Worker parity without private capabilities or caller authority', () => {
  const execution = {
    version: 1,
    run_id: randomUUID(),
    lease_id: randomUUID(),
    group_id: randomUUID(),
    profile_id: randomUUID(),
    session_id: randomUUID(),
    runtime_id: randomUUID(),
    grant_id: randomUUID(),
    cancel_epoch: 0,
    deadline_at: Date.now() + 60000,
    max_model_attempts: 6,
    tool_capabilities: ['inspect_text', 'create_approved_artifact'],
  };
  const source = {
    conversationId: 1,
    generationTaskId: 8,
    attempt: 1,
    inputs: [
      { submissionId: 5, requestId: 'original-public-input', entryId: 4 },
    ],
  };
  const proof = {
    version: 1,
    owner_revision: 3,
    execution,
    context_digest: 'a'.repeat(64),
    source,
  };
  expect(workerExecution.parse(execution)).toEqual(
    nodeExecution.parse(execution),
  );
  expect(workerModel.parse(proof)).toEqual(nodeModel.parse(proof));
  const denial = { ...proof, local_budget_exhausted: true };
  expect(workerModel.parse(denial)).toEqual(nodeModel.parse(denial));
  const effect = {
    version: 1,
    execution,
    source: {
      conversationId: 1,
      toolTaskId: 9,
      generationTaskId: 8,
      inputs: source.inputs,
    },
  };
  expect(workerEffect.parse(effect)).toEqual(nodeEffect.parse(effect));
  for (const changed of [
    { ...effect, source: { ...effect.source, conversationId: 2 } },
    { ...effect, source: { ...effect.source, toolTaskId: 0 } },
    { ...effect, source: { ...effect.source, inputs: [] } },
    {
      ...effect,
      source: { ...effect.source, private_transcript: 'PRIVATE_CANARY' },
    },
    {
      ...effect,
      execution: { ...execution, tool_capabilities: ['read_device_file'] },
    },
  ]) {
    expect(nodeEffect.safeParse(changed).success).toBe(false);
    expect(workerEffect.safeParse(changed).success).toBe(false);
  }
  for (const changed of [
    { ...execution, tool_capabilities: ['read_personal_memory'] },
    { ...execution, tool_capabilities: ['read_device_file'] },
    { ...execution, tool_capabilities: ['inspect_text', 'inspect_text'] },
    { ...execution, owner_user_id: 'mallory' },
    { ...execution, cancel_epoch: -1 },
    { ...execution, max_model_attempts: 13 },
    { ...execution, lease_id: '' },
  ]) {
    expect(nodeExecution.safeParse(changed).success).toBe(false);
    expect(workerExecution.safeParse(changed).success).toBe(false);
  }
  for (const changed of [
    { ...proof, local_budget_exhausted: false },
    { ...proof, owner_revision: 0 },
    { ...proof, owner_revision: undefined },
    { ...proof, context_digest: 'unknown' },
    { ...proof, provider_key: 'PRIVATE_CANARY' },
    { ...proof, source: { ...source, conversationId: 2 } },
    { ...proof, source: { ...source, attempt: 0 } },
    { ...proof, source: { ...source, inputs: [] } },
    {
      ...proof,
      source: { ...source, inputs: [...source.inputs, ...source.inputs] },
    },
    { ...proof, source: { ...source, private_transcript: 'PRIVATE_CANARY' } },
  ]) {
    expect(nodeModel.safeParse(changed).success).toBe(false);
    expect(workerModel.safeParse(changed).success).toBe(false);
  }
});

test('Node and independently installed Worker validators agree on member-tool envelopes and reject model-supplied authority', () => {
  const sender = randomUUID(),
    recipient = randomUUID(),
    source = {
      conversationId: 1,
      toolTaskId: 9,
      generationTaskId: 8,
      inputs: [
        { submissionId: 5, requestId: 'original-public-input', entryId: 4 },
      ],
    };
  const ask = {
    kind: 'group_member_tool',
    id: 'task:9',
    task_id: 9,
    call_id: 'native-call-9',
    name: 'ask_group_dot',
    phase: 'prepare',
    parameters: {
      recipient_profile_id: recipient,
      message: 'Review only this public preview task.',
    },
    parameters_digest: 'a'.repeat(64),
    source,
  };
  const binding = {
    version: 1,
    id: randomUUID(),
    run_id: randomUUID(),
    group_id: randomUUID(),
    owner_user_id: 'alice',
    sender_profile_id: sender,
    recipient_profile_id: recipient,
    recipient_session_id: randomUUID(),
    source_session_id: randomUUID(),
    source_input_id: 'product-original-input',
    source_task_id: 9,
    source_generation_id: 8,
    source_call_id: 'native-call-9',
    source_inputs: source.inputs,
    content: ask.parameters.message,
    hop: 1,
    deadline_at: Date.now() + 60000,
    cancel_epoch: 0,
  };
  const valid = [
    ask,
    { ...ask, phase: 'send', binding },
    { ...ask, name: 'read_group_context', phase: 'read', parameters: {} },
  ];
  const invalid = [
    { ...ask, parameters: { ...ask.parameters, owner_user_id: 'mallory' } },
    { ...ask, source: { ...source, conversationId: 2 } },
    { ...ask, source: { ...source, private_transcript: 'PRIVATE_CANARY' } },
    {
      ...ask,
      source: { ...source, inputs: [...source.inputs, ...source.inputs] },
    },
    { ...ask, phase: 'urgent' },
    { ...ask, phase: 'send' },
  ];
  for (const value of valid) {
    expect(nodeSchema.safeParse(value).success).toBe(true);
    expect(workerSchema.parse(value)).toEqual(nodeSchema.parse(value));
  }
  for (const value of invalid) {
    expect(nodeSchema.safeParse(value).success).toBe(false);
    expect(workerSchema.safeParse(value).success).toBe(false);
  }
});
