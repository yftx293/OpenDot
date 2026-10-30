import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { CloudMemberToolRequestSchema } from '../bot-groups/member-wire.js';
import {
  memberToolContext,
  assertMemberAuthority,
  assertMemberCurrentControl,
  prepareMemberSend,
  admitMemberSend,
} from '../bot-groups/member-inbox-store.js';
import { memberModelLimits } from '../bot-groups/member-model-store.js';
import { getBotHandoffService } from '../bot-groups/handoff-service.js';
import { assertCloudAuthority } from './cloud-authority.js';
import { CloudError, digest, type CloudScope } from './cloud-wire.js';

/** Existing signed /tools RPC only. IDs/provenance are supplied by the Worker
 * host after reading native state, never from model parameters or Cookies. */
export async function cloudMemberTool(
  scope: CloudScope,
  objectId: string,
  raw: unknown,
) {
  const input = CloudMemberToolRequestSchema.parse(raw);
  // The strict wire schema permits only 1; use the SDK's branded Root identity.
  const source = { ...input.source, conversationId: ROOT_CONVERSATION_ID };
  const authorize = () => {
    const current = assertCloudAuthority(scope, objectId);
    const member = assertMemberAuthority(scope.session_id, input.name);
    if (
      !current.binding.group_session ||
      current.binding.group_session.group_id !== member.run.group_id ||
      current.binding.group_session.profile_id !== member.lease.profile_id ||
      member.origin.runtime_kind !== 'cloudflare-durable' ||
      !memberModelLimits(member.run.id)
    )
      throw new CloudError(409, 'CLOUD_MEMBER_SOURCE_SCOPE_CONFLICT');
    return member;
  };
  authorize();
  if (
    input.id !== `task:${input.task_id}` ||
    input.source.toolTaskId !== input.task_id ||
    input.parameters_digest !== (await digest(JSON.stringify(input.parameters)))
  )
    throw new CloudError(409, 'CLOUD_MEMBER_TOOL_IDENTITY_CONFLICT');
  authorize();
  const context = memberToolContext(scope.session_id, source);
  let output;
  if (input.name === 'read_group_context') {
    output = {
      group_id: context.run.group_id,
      run_id: context.run.id,
      native_task_id: input.task_id,
      inputs: context.inputs.map((i) => ({
        request_id: i.native.requestId,
        submission_id: i.native.submissionId,
        context: JSON.parse(JSON.parse(i.row.payload).content),
      })),
    };
  } else {
    assertMemberCurrentControl(context);
    if (input.phase === 'prepare')
      output = prepareMemberSend(
        scope.session_id,
        source,
        input.call_id,
        input.parameters.recipient_profile_id,
        input.parameters.message,
      );
    else {
      const b = input.binding;
      if (
        b.source_observation_trace_id !== undefined ||
        b.source_session_id !== scope.session_id ||
        b.source_call_id !== input.call_id ||
        b.source_task_id !== input.task_id ||
        b.recipient_profile_id !== input.parameters.recipient_profile_id ||
        b.content !== input.parameters.message
      )
        throw new CloudError(409, 'CLOUD_MEMBER_TOOL_IDENTITY_CONFLICT');
      const mail = admitMemberSend(b, source);
      getBotHandoffService()?.discussions.kick(mail.run_id);
      output = {
        message_id: mail.id,
        canonical_message_id: mail.message_id,
        recipient_profile_id: mail.recipient_profile_id,
        state: mail.state,
        admission_only: true,
      };
    }
  }
  authorize();
  return {
    id: input.id,
    task_id: input.task_id,
    call_id: input.call_id,
    parameters_digest: input.parameters_digest,
    output,
  };
}
