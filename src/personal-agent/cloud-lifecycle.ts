import { memberStopLease } from '../bot-groups/member-inbox-store.js';
import { memberStopRecord } from '../bot-groups/member-stop-store.js';
import {
  groupSessionOrigin,
  getDiscussion,
  discussionStopTurn,
} from '../bot-groups/discussion-store.js';
import { z } from 'zod';
import {
  handoffForProductSession,
  matchesBotHandoffCloudGrant,
} from '../bot-groups/handoff-store.js';
import { getTaskRunById } from '../db.js';
import { goalForProductSession } from './goal-store.js';
import {
  getCloudPlacement,
  requireProductRuntime,
  requireCloudExecution,
  CloudExecutionRefSchema,
} from './product-runtime-store.js';
import {
  CloudError,
  digest,
  type CloudBinding,
  type CloudScope,
} from './cloud-wire.js';
export const CloudHandoffFenceSchema = z
  .object({
    kind: z.literal('handoff'),
    handoff_id: z.uuid(),
    handoff_revision: z.number().int().positive(),
  })
  .strict();
export const CloudStopFenceSchema = z.discriminatedUnion('kind', [
  CloudHandoffFenceSchema,
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
export type CloudStopFence = z.infer<typeof CloudStopFenceSchema>;
/** Stopping grants no execution/read rights. Revocation must still be able to
 * stop an already registered owner after Host/provider access was removed. */
export async function cloudStopPolicy(
  scope: CloudScope,
  objectId: string,
  raw: unknown,
) {
  const input = z
    .object({
      fence: CloudStopFenceSchema,
      execution: CloudExecutionRefSchema.optional(),
    })
    .strict()
    .parse(raw);
  const runtime = requireProductRuntime(scope.session_id, scope.owner_user_id),
    placement = getCloudPlacement(scope.session_id);
  const binding =
    placement &&
    (JSON.parse(placement.binding_json) as CloudBinding | undefined);
  if (
    !placement ||
    runtime.runtime_kind !== 'pi-durable' ||
    placement.object_id !== objectId ||
    !binding ||
    (!binding.goal_id &&
      !binding.bot_handoff &&
      !groupSessionOrigin(scope.session_id)) ||
    (binding.goal_id ?? null) !== runtime.goal_id ||
    binding.owner_user_id !== runtime.owner_user_id ||
    binding.workspace_jid !== runtime.workspace_jid ||
    binding.config_fingerprint !== runtime.config_fingerprint ||
    binding.runtime_id !== placement.runtime_id ||
    binding.execution_authority !== 'miniclaw-product'
  )
    throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  for (const field of [
    'owner_user_id',
    'workspace_jid',
    'session_id',
    'runtime_id',
    'config_fingerprint',
  ] as const)
    if (binding[field] !== scope[field])
      throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  const fence = input.fence;
  const origin = groupSessionOrigin(scope.session_id);
  if (origin) {
    if (
      !['group_discussion', 'group_member'].includes(fence.kind) ||
      input.execution ||
      binding.goal_id ||
      binding.bot_handoff
    )
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
    if (fence.kind !== 'group_discussion' && fence.kind !== 'group_member')
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
    const run = getDiscussion(fence.run_id),
      turn = discussionStopTurn(scope.session_id, fence.run_id),
      member = memberStopLease(scope.session_id, fence.run_id);
    if (
      !binding.group_session ||
      binding.group_session.group_id !== origin.group_id ||
      binding.group_session.profile_id !== origin.profile_id ||
      !run ||
      run.group_id !== origin.group_id ||
      (run.status === 'running' &&
        !(
          fence.kind === 'group_member' &&
          member &&
          memberStopRecord(member.id)
        )) ||
      (fence.kind === 'group_member'
        ? !member ||
          member.id !== fence.lease_id ||
          member.cancel_epoch !== fence.cancel_epoch
        : !turn || turn.id !== fence.turn_id) ||
      origin.stopping_run_id !== run.id
    )
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
    return {
      authorized: true,
      session_id: scope.session_id,
      runtime_id: scope.runtime_id,
      object_id: objectId,
      fence_digest: await digest(JSON.stringify(fence)),
      mode: 'suspended' as const,
    };
  }
  if (fence.kind === 'group_discussion' || fence.kind === 'group_member')
    throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
  if (binding.bot_handoff) {
    const handoff = handoffForProductSession(scope.session_id);
    if (
      !handoff ||
      input.execution ||
      fence.kind !== 'handoff' ||
      fence.handoff_id !== handoff.id ||
      fence.handoff_revision !== handoff.revision ||
      !matchesBotHandoffCloudGrant(handoff, binding) ||
      ![
        'paused',
        'cancelling',
        'cancelled',
        'completed',
        'failed',
        'uncertain',
      ].includes(handoff.state)
    )
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
    // This proof permits only closing the registered owner. It deliberately
    // does not consult Host/model execution access, which may already be gone.
    return {
      authorized: true,
      session_id: scope.session_id,
      runtime_id: scope.runtime_id,
      object_id: objectId,
      fence_digest: await digest(JSON.stringify(fence)),
      mode:
        runtime.state === 'blocked' || handoff.state !== 'paused'
          ? ('cancelled' as const)
          : ('suspended' as const),
    };
  }
  if (fence.kind === 'handoff')
    throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
  if (input.execution)
    requireCloudExecution(scope.session_id, input.execution, true);
  const goal = goalForProductSession(scope.session_id);
  if (!goal || goal.id !== binding.goal_id)
    throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
  let cancelled =
    runtime.state === 'blocked' ||
    ['cancelled', 'completed', 'failed'].includes(goal.status);
  if (fence.kind === 'goal') {
    if (
      fence.goal_id !== goal.id ||
      fence.goal_revision !== goal.revision ||
      !['paused', 'cancelled', 'completed', 'failed'].includes(goal.status)
    )
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
  } else {
    const run = getTaskRunById(fence.run_id),
      context = run?.definition_snapshot.personal_goal;
    const owns =
      run?.lease_owner === fence.lease_owner &&
      run.lease_token === fence.lease_token;
    const justCancelled =
      run?.status === 'cancelled' &&
      run.lease_owner === null &&
      run.lease_token === fence.lease_token + 1;
    if (
      !run?.started_at ||
      !context ||
      context.session_id !== scope.session_id ||
      context.goal_id !== goal.id ||
      context.owner_user_id !== scope.owner_user_id ||
      context.workspace_jid !== scope.workspace_jid ||
      (!owns && !justCancelled) ||
      (input.execution && input.execution.run_id !== run.id)
    )
      throw new CloudError(409, 'CLOUD_STOP_FENCE_CHANGED');
    cancelled ||= run.status === 'cancelled';
  }
  return {
    authorized: true,
    session_id: scope.session_id,
    runtime_id: scope.runtime_id,
    object_id: objectId,
    fence_digest: await digest(JSON.stringify(fence)),
    mode: cancelled ? ('cancelled' as const) : ('suspended' as const),
  };
}
