import { cloudMemberTool } from './cloud-member-tools.js';
import { endDiscussion } from '../bot-groups/discussion-store.js';
import { getBotHandoffService } from '../bot-groups/handoff-service.js';
import { logger } from '../logger.js';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import {
  memberCloudExecution,
  memberSessionLease,
  memberToolContext,
  assertMemberAuthority,
  assertMemberCurrentControl,
} from '../bot-groups/member-inbox-store.js';
import { z } from 'zod';
import { assertCloudAuthority } from './cloud-authority.js';
import { CloudError, digest, type CloudScope } from './cloud-wire.js';
import { readPersonalMemoryForSession } from './personal-memory.js';
import { CloudExecutionRefSchema } from './product-runtime-store.js';
import {
  CloudArtifactRequestSchema,
  cloudArtifactTool,
} from './cloud-artifact-tool.js';
import {
  CloudDeviceRequestSchema,
  CloudDeviceIntentSchema,
} from './cloud-device-wire.js';
import {
  findCloudDeviceRequest,
  proposeCloudDeviceRequest,
  cloudDeviceStatus,
  confirmCloudDeviceResult,
} from './cloud-device-store.js';
import { DeviceError, auditDevice } from './device-store.js';

// The Worker host fills task/conversation identity from ToolExecutionApi. None
// of these authority fields are model parameters or browser claims.
const MemoryRequestSchema = z
  .object({
    id: z.string().regex(/^task:[1-9][0-9]*$/),
    conversation_id: z.literal(1),
    task_id: z.number().int().positive(),
    call_id: z.string().min(1).max(256),
    name: z.literal('read_personal_memory'),
    parameters: z.object({ query: z.string().max(500) }).strict(),
    parameters_digest: z.string().regex(/^[a-f0-9]{64}$/),
    execution: CloudExecutionRefSchema.optional(),
  })
  .strict();
const RequestSchema = z.discriminatedUnion('name', [
  MemoryRequestSchema,
  CloudArtifactRequestSchema,
  CloudDeviceRequestSchema,
]);

export async function cloudTool(
  scope: CloudScope,
  objectId: string,
  raw: unknown,
) {
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as { kind?: unknown }).kind === 'group_member_tool'
  )
    return cloudMemberTool(scope, objectId, raw);
  const input = RequestSchema.parse(raw);
  const authorize = () => {
    const current = assertCloudAuthority(
      scope,
      objectId,
      false,
      input.name === 'create_approved_artifact' &&
        ['status', 'probe'].includes(input.phase),
      input.name === 'read_device_file' ? undefined : input.execution,
    );
    if (current.binding.goal_id && !current.execution)
      throw new CloudError(409, 'CLOUD_EXECUTION_GRANT_REQUIRED');
    const member =
      input.name === 'create_approved_artifact' ? input.member : undefined;
    const memberLease = memberSessionLease(scope.session_id);
    let granted = current.binding.tool_capabilities?.includes(input.name);
    if (member || memberLease) {
      if (
        !member ||
        input.name !== 'create_approved_artifact' ||
        input.execution
      )
        throw new CloudError(409, 'CLOUD_MEMBER_SOURCE_REQUIRED');
      const context = memberToolContext(scope.session_id, {
        ...member.source,
        conversationId: ROOT_CONVERSATION_ID,
      });
      const expected = memberCloudExecution(
        scope.session_id,
        member.source.inputs[0].requestId,
      );
      if (
        !expected ||
        JSON.stringify(expected) !== JSON.stringify(member.execution) ||
        member.source.toolTaskId !== input.task_id ||
        member.source.generationTaskId !== input.generation_task_id ||
        context.origin.runtime_kind !== 'cloudflare-durable' ||
        current.binding.group_session?.group_id !== context.run.group_id ||
        current.binding.group_session?.profile_id !== context.lease.profile_id
      )
        throw new CloudError(409, 'CLOUD_MEMBER_SOURCE_SCOPE_CONFLICT');
      assertMemberAuthority(scope.session_id, input.name);
      // Reading an immutable denied receipt must let the parked native Task
      // unwind and reach its queued control boundary. Only proposing/executing
      // an effect requires the latest instruction in that Task's source.
      if (input.phase === 'propose' || input.phase === 'execute')
        assertMemberCurrentControl(context);
      granted = expected.tool_capabilities.includes(input.name);
    }
    if (
      current.runtime.state !== 'ready' ||
      current.runtime.conversation_id !== 1 ||
      !granted ||
      (input.name === 'read_device_file'
        ? process.env.MINICLAW_CLOUD_DEVICES !== 'true' &&
          !findCloudDeviceRequest(scope.session_id, input.task_id)
        : process.env[
            input.name === 'read_personal_memory'
              ? 'MINICLAW_CLOUD_MEMORY'
              : 'MINICLAW_CLOUD_APPROVALS'
          ] !== 'true')
    )
      throw new CloudError(403, 'CLOUD_TOOL_NOT_GRANTED');
    return current;
  };
  authorize();
  if (
    input.id !== `task:${input.task_id}` ||
    input.parameters_digest !== (await digest(JSON.stringify(input.parameters)))
  )
    throw new CloudError(409, 'CLOUD_TOOL_INTENT_CONFLICT');
  authorize();
  // Existing helper enforces Home/source ownership, destination grants, exact
  // approved revisions, active users/Workspaces, expiration and read auditing.
  let output;
  if (input.name === 'read_device_file') {
    try {
      const { phase, receipt, result_digest, ...rawIntent } = input,
        intent = CloudDeviceIntentSchema.parse(rawIntent);
      let current = findCloudDeviceRequest(scope.session_id, intent.task_id);
      if (
        current &&
        (current.intent !== JSON.stringify(intent) ||
          (receipt && JSON.stringify(receipt) !== current.identity))
      )
        throw new CloudError(409, 'CLOUD_DEVICE_IDENTITY_CONFLICT');
      if (!current && phase === 'probe') output = { state: 'missing' };
      else {
        if (!current && phase !== 'propose')
          throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
        current ??= proposeCloudDeviceRequest(scope.session_id, intent);
        if (['status', 'consume', 'confirm'].includes(phase) && !receipt)
          throw new CloudError(409, 'CLOUD_DEVICE_RECEIPT_REQUIRED');
        if (phase === 'confirm') {
          if (!result_digest)
            throw new CloudError(409, 'CLOUD_DEVICE_RESULT_UNCONFIRMED');
          confirmCloudDeviceResult(current, result_digest);
        }
        output = cloudDeviceStatus(current, phase === 'consume');
        if (phase === 'consume')
          auditDevice(
            scope.owner_user_id,
            current.node_id,
            scope.session_id,
            current.id,
            'cloud_file_delivery',
            'returned',
            { operation_digest: JSON.parse(current.identity).operation_digest },
          );
      }
    } catch (error) {
      if (error instanceof DeviceError)
        throw new CloudError(403, 'CLOUD_DEVICE_NOT_AUTHORIZED');
      throw error;
    }
  } else
    output =
      input.name === 'create_approved_artifact'
        ? cloudArtifactTool(
            scope,
            authorize().binding,
            input,
            authorize,
            authorize().execution,
          )
        : readPersonalMemoryForSession(
            scope.session_id,
            input.task_id,
            input.parameters.query,
          );
  authorize();
  if (
    input.name === 'create_approved_artifact' &&
    input.member &&
    'state' in output &&
    output.state === 'uncertain'
  ) {
    // This native Tool is bound to the current lease/input, not an arbitrary
    // historical approval on the persistent Session. Cloud blocks its Harness
    // on uncertainty; surface that terminal effect now instead of waiting for
    // the unanswered question to expire. Keep its immutable receipt intact.
    const { run } = memberToolContext(scope.session_id, {
      ...input.member.source,
      conversationId: ROOT_CONVERSATION_ID,
    });
    endDiscussion(run.id, 'failed', 'GROUP_MEMBER_EFFECT_UNCERTAIN');
    const service = getBotHandoffService();
    if (service)
      void service.discussions.stop(run.group_id, run.id).catch(() => {
        logger.warn(
          { sessionId: scope.session_id, runId: run.id },
          'Group uncertain effect stop remains pending',
        );
      });
  }
  return {
    id: input.id,
    task_id: input.task_id,
    call_id: input.call_id,
    parameters_digest: input.parameters_digest,
    output,
  };
}
