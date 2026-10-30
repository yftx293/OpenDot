// Wire validation only: safe in Node and Workers; no database or runtime import.
import { z } from 'zod';

export const MemberSendBindingSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    run_id: z.uuid(),
    group_id: z.uuid(),
    owner_user_id: z.string().min(1),
    sender_profile_id: z.uuid(),
    recipient_profile_id: z.uuid(),
    recipient_session_id: z.uuid(),
    source_session_id: z.uuid(),
    source_input_id: z.string().min(1),
    source_task_id: z.number().int().positive(),
    source_generation_id: z.number().int().positive(),
    source_observation_trace_id: z
      .string()
      .regex(/^(?:[0-9a-f]{32})?$/)
      .optional(),
    source_call_id: z.string().min(1),
    source_inputs: z
      .array(
        z
          .object({
            submissionId: z.number().int().positive(),
            requestId: z.string(),
            entryId: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    content: z.string().min(1).max(4096),
    hop: z.number().int().min(1).max(4),
    deadline_at: z.number().int().positive(),
    cancel_epoch: z.number().int().nonnegative(),
  })
  .strict();
export type MemberSendBinding = z.infer<typeof MemberSendBindingSchema>;

const SourceSchema = z
  .object({
    conversationId: z.literal(1),
    toolTaskId: z.number().int().positive(),
    generationTaskId: z.number().int().positive(),
    inputs: MemberSendBindingSchema.shape.source_inputs.refine(
      (rows) =>
        new Set(rows.map((row) => row.submissionId)).size === rows.length &&
        new Set(rows.map((row) => row.requestId)).size === rows.length,
    ),
  })
  .strict();
const common = {
  kind: z.literal('group_member_tool'),
  id: z.string().regex(/^task:[1-9][0-9]*$/),
  task_id: z.number().int().positive(),
  call_id: z.string().min(1).max(256),
  parameters_digest: z.string().regex(/^[a-f0-9]{64}$/),
  source: SourceSchema,
};
const ask = {
  ...common,
  name: z.literal('ask_group_dot'),
  parameters: z
    .object({
      recipient_profile_id: z.uuid(),
      message: z.string().min(1).max(4096),
    })
    .strict(),
};
export const CloudMemberToolRequestSchema = z.union([
  z.object({ ...ask, phase: z.literal('prepare') }).strict(),
  z
    .object({
      ...ask,
      phase: z.literal('send'),
      binding: MemberSendBindingSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      name: z.literal('read_group_context'),
      phase: z.literal('read'),
      parameters: z.object({}).strict(),
    })
    .strict(),
]);
export type CloudMemberToolRequest = z.infer<
  typeof CloudMemberToolRequestSchema
>;

export const CloudMemberExecutionSchema = z
  .object({
    version: z.literal(1),
    run_id: z.uuid(),
    lease_id: z.uuid(),
    group_id: z.uuid(),
    profile_id: z.uuid(),
    session_id: z.uuid(),
    runtime_id: z.uuid(),
    grant_id: z.uuid(),
    cancel_epoch: z.number().int().nonnegative(),
    deadline_at: z.number().int().positive(),
    max_model_attempts: z.number().int().min(1).max(12),
    tool_capabilities: z
      .array(z.enum(['inspect_text', 'create_approved_artifact']))
      .max(2)
      .refine((names) => new Set(names).size === names.length),
  })
  .strict();
export type CloudMemberExecution = z.infer<typeof CloudMemberExecutionSchema>;
export const CloudMemberEffectProofSchema = z
  .object({
    version: z.literal(1),
    execution: CloudMemberExecutionSchema,
    source: SourceSchema,
  })
  .strict();
export type CloudMemberEffectProof = z.infer<
  typeof CloudMemberEffectProofSchema
>;
export const CloudMemberModelProofSchema = z
  .object({
    version: z.literal(1),
    local_budget_exhausted: z.literal(true).optional(),
    owner_revision: z.number().int().positive(),
    execution: CloudMemberExecutionSchema,
    context_digest: z.string().regex(/^[a-f0-9]{64}$/),
    source: z
      .object({
        conversationId: z.literal(1),
        generationTaskId: z.number().int().positive(),
        attempt: z.number().int().positive(),
        inputs: MemberSendBindingSchema.shape.source_inputs.refine(
          (rows) =>
            new Set(rows.map((r) => r.submissionId)).size === rows.length &&
            new Set(rows.map((r) => r.requestId)).size === rows.length,
        ),
      })
      .strict(),
  })
  .strict();
export type CloudMemberModelProof = z.infer<typeof CloudMemberModelProofSchema>;
