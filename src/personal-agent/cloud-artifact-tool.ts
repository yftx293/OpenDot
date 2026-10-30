import { z } from 'zod';
import {
  getProductApproval,
  finishApprovedArtifact,
  listProductApprovals,
  requestArtifactApproval,
} from './approval-store.js';
import { executeApprovedArtifact } from './artifact-effect.js';
import {
  listQueueControls,
  CloudExecutionRefSchema,
} from './product-runtime-store.js';
import {
  CloudError,
  type CloudBinding,
  type CloudScope,
  type CloudExecutionGrant,
} from './cloud-wire.js';
import type { PreparedQueueCommand } from './queue-control.js';
import { CloudMemberEffectProofSchema } from '../bot-groups/member-wire.js';

export const CloudArtifactRequestSchema = z
  .object({
    id: z.string().regex(/^task:[1-9][0-9]*$/),
    conversation_id: z.literal(1),
    task_id: z.number().int().positive(),
    generation_task_id: z.number().int().positive(),
    call_id: z.string().min(1).max(256),
    name: z.literal('create_approved_artifact'),
    parameters: z.object({ content: z.string().min(1).max(65536) }).strict(),
    parameters_digest: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['probe', 'propose', 'status', 'execute']),
    approval_id: z.uuid().optional(),
    execution: CloudExecutionRefSchema.optional(),
    member: CloudMemberEffectProofSchema.optional(),
  })
  .strict();

export function cloudArtifactTool(
  scope: CloudScope,
  binding: CloudBinding,
  input: z.infer<typeof CloudArtifactRequestSchema>,
  authorize: () => void,
  execution?: CloudExecutionGrant,
) {
  const check = () => {
    authorize();
    // A committed product Abort intent fences effects before transport/native
    // ACK. It cannot affect a later generation with a different stable ID.
    if (
      listQueueControls(scope.session_id).some((row) => {
        const prepared = JSON.parse(row.payload) as PreparedQueueCommand;
        return (
          row.state !== 'rejected' &&
          prepared.command.action === 'abort' &&
          prepared.command.taskId === input.generation_task_id
        );
      })
    )
      throw new CloudError(409, 'CLOUD_TOOL_GENERATION_ABORTED');
  };
  check();
  const previous = listProductApprovals(
    scope.session_id,
    scope.owner_user_id,
  ).find((row) => row.tool_task_id === input.task_id);
  if (!previous && input.phase !== 'propose') {
    if (input.phase === 'probe') return { state: 'missing' as const };
    throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
  }
  if (input.approval_id && previous?.id !== input.approval_id)
    throw new CloudError(409, 'CLOUD_APPROVAL_IDENTITY_CONFLICT');
  let current;
  try {
    current = requestArtifactApproval(
      scope.session_id,
      input.task_id,
      input.parameters.content,
      execution
        ? {
            goalId: execution.goal_id,
            runId: execution.run_id,
            taskId: execution.task_id,
          }
        : undefined,
      {
        deadlineAt:
          input.member?.execution.deadline_at ??
          execution?.deadline_at ??
          binding.deadline_at,
        generationTaskId: input.generation_task_id,
        callId: input.call_id,
        runtimeId: binding.runtime_id,
        parametersDigest: input.parameters_digest,
        ...(input.member ? { member: input.member } : {}),
      },
    );
  } catch {
    throw new CloudError(409, 'CLOUD_APPROVAL_INTENT_CONFLICT');
  }
  if (input.phase === 'execute') {
    if (!input.approval_id)
      throw new CloudError(409, 'CLOUD_APPROVAL_RECEIPT_REQUIRED');
    if (['approved', 'executing', 'completed'].includes(current.state)) {
      check();
      try {
        current = executeApprovedArtifact(
          current.id,
          scope.owner_user_id,
          check,
        );
      } catch (error) {
        current = getProductApproval(current.id, scope.owner_user_id);
        // This HTTP invocation has ended without a confirmed receipt. A known
        // authorization/filesystem failure after begin must be visible as
        // uncertain; a killed process remains executing for safe reconciliation.
        if (current.state === 'executing')
          current = finishApprovedArtifact(
            current.id,
            scope.owner_user_id,
            false,
          );
        if (error instanceof CloudError) throw error;
        if (!['uncertain', 'executing'].includes(current.state)) throw error;
      }
    }
  }
  check();
  return {
    approval_id: current.id,
    parameters_digest: current.parameters_digest,
    content_digest: current.content_digest,
    state: current.state,
    expires_at: current.expires_at,
  };
}
