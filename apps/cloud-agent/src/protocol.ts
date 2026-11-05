import { CloudMemberExecutionSchema } from './member-protocol.js';
import { z, ZodError } from 'zod';
import {
  ExecutionGrantSchema,
  ExecutionRefSchema,
} from './execution-protocol.js';
export const RUNTIME_KIND = 'cloudflare-durable' as const;
import {
  CloudError,
  CLOUD_TOOL_CAPABILITIES,
} from '../../../src/personal-agent/cloud-wire.js';
export {
  CloudError,
  digest,
  signedRequest,
  authenticate,
  boundedBody,
} from '../../../src/personal-agent/cloud-wire.js';
export const BindingSchema = z
  .object({
    version: z.literal(1),
    owner_user_id: z.string().min(1).max(200),
    workspace_jid: z.string().startsWith('web:').max(256),
    session_id: z.uuid(),
    runtime_id: z.uuid(),
    config_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    provider_id: z.string().min(1).max(200),
    model_id: z.string().min(1).max(200),
    instructions: z.string().max(32768),
    max_model_steps: z.number().int().min(1).max(24),
    deadline_at: z.number().int().positive(),
    execution_authority: z.literal('miniclaw-product').optional(),
    tool_capabilities: z
      .array(z.enum(CLOUD_TOOL_CAPABILITIES))
      .max(CLOUD_TOOL_CAPABILITIES.length)
      .refine((names) => new Set(names).size === names.length)
      .optional(),
    goal_id: z.uuid().optional(),
    group_session: z
      .object({ group_id: z.uuid(), profile_id: z.uuid() })
      .strict()
      .optional(),
    // Keep runtime validators in this workspace: its standalone install must
    // not require the Node authority's zod/package graph. Tests compare both.
    bot_handoff: z
      .object({
        handoff_id: z.uuid(),
        group_id: z.uuid(),
        grant_digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SessionBinding = z.infer<typeof BindingSchema>;
export const ProvisionSchema = z
  .union([
    BindingSchema,
    z
      .object({ binding: BindingSchema, execution: ExecutionGrantSchema })
      .strict(),
  ])
  .refine((value) => {
    const binding = 'binding' in value ? value.binding : value;
    if (
      binding.group_session &&
      (binding.goal_id ||
        binding.bot_handoff ||
        binding.execution_authority !== 'miniclaw-product' ||
        binding.tool_capabilities === undefined ||
        binding.tool_capabilities.some(
          (name) =>
            !['inspect_text', 'create_approved_artifact'].includes(name),
        ))
    )
      return false;
    if (
      binding.bot_handoff &&
      (binding.goal_id ||
        binding.execution_authority !== 'miniclaw-product' ||
        binding.tool_capabilities === undefined ||
        binding.tool_capabilities.some(
          (name) =>
            name !== 'create_approved_artifact' &&
            name !== 'inspect_text' &&
            name !== 'read_device_file',
        ))
    )
      return false;
    return binding.goal_id
      ? 'binding' in value && binding.execution_authority === 'miniclaw-product'
      : !('binding' in value);
  });
export const InputSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    content: z.string().min(1).max(32768),
    when_busy: z.enum(['followUp', 'steer']).default('followUp'),
    product_receipt_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    execution: ExecutionRefSchema.optional(),
    member: CloudMemberExecutionSchema.optional(),
  })
  .strict();
export type CloudInput = z.infer<typeof InputSchema>;
// This is a frozen occurrence from the existing business Scheduler, not a cron definition.
export const WakeSchema = z
  .object({
    execution_id: z.uuid(),
    not_before: z.number().int().positive(),
    input: InputSchema,
  })
  .strict();
export type CloudWake = z.infer<typeof WakeSchema>;
export const ScopeSchema = BindingSchema.pick({
  owner_user_id: true,
  workspace_jid: true,
  session_id: true,
  runtime_id: true,
  config_fingerprint: true,
}).strip();
export type Scope = z.infer<typeof ScopeSchema>;
export function scopeMatches(binding: SessionBinding, scope: Scope) {
  return Object.entries(ScopeSchema.parse(binding)).every(
    ([key, value]) => scope[key as keyof Scope] === value,
  );
}
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function failure(error: unknown) {
  if (error instanceof ZodError || error instanceof SyntaxError)
    return json({ error: 'CLOUD_INVALID_REQUEST' }, 400);
  return error instanceof CloudError
    ? json({ error: error.code }, error.status)
    : json({ error: 'CLOUD_OPERATION_UNAVAILABLE' }, 503);
}
