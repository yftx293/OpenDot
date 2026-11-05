import { z } from 'zod';
import type {
  CloudExecutionGrant,
  CloudExecutionRef,
} from '../../../src/personal-agent/cloud-wire.js';

// Keep this independent of the Node authority and its dependency graph. Tests
// compare these wire validators with the Node issuer's actual schemas.
export const ExecutionRefSchema = z
  .object({
    goal_id: z.uuid(),
    run_id: z.uuid(),
    context_digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const ExecutionGrantSchema = ExecutionRefSchema.extend({
  version: z.literal(1),
  session_id: z.uuid(),
  runtime_id: z.uuid(),
  task_id: z.uuid(),
  snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
  max_model_steps: z.literal(12),
  issued_at: z.number().int().nonnegative(),
  deadline_at: z.number().int().positive(),
})
  .strict()
  .refine(
    (grant) =>
      grant.deadline_at > grant.issued_at &&
      grant.deadline_at - grant.issued_at <= 86400000,
  );
export function executionRef(grant: CloudExecutionGrant): CloudExecutionRef {
  return {
    goal_id: grant.goal_id,
    run_id: grant.run_id,
    context_digest: grant.context_digest,
  };
}
export function sameExecution(a: CloudExecutionRef, b: CloudExecutionRef) {
  return (
    a.goal_id === b.goal_id &&
    a.run_id === b.run_id &&
    a.context_digest === b.context_digest
  );
}

export const HandoffFenceSchema = z
  .object({
    kind: z.literal('handoff'),
    handoff_id: z.uuid(),
    handoff_revision: z.number().int().positive(),
  })
  .strict();
export const StopFenceSchema = z.discriminatedUnion('kind', [
  HandoffFenceSchema,
  z
    .object({
      kind: z.literal('group_member'),
      run_id: z.uuid(),
      lease_id: z.uuid(),
      cancel_epoch: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group_discussion'),
      run_id: z.uuid(),
      turn_id: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('claim'),
      run_id: z.uuid(),
      lease_owner: z.string().min(1).max(256),
      lease_token: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('goal'),
      goal_id: z.uuid(),
      goal_revision: z.number().int().positive(),
    })
    .strict(),
]);
export const StopRequestSchema = z.object({ fence: StopFenceSchema }).strict();
