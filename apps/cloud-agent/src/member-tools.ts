import { defineTool } from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { MemberSendBindingSchema } from './member-protocol';
import { cloudMemberSource } from './member-source';
import { productTool, type AuthorityEnvironment } from './authority';
import { CloudError, digest, type SessionBinding } from './protocol';

/** Registered definitions do not grant access. The product must explicitly
 * select these for a validated member Run; legacy Group tools stay unchanged. */
export function cloudMemberTools(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  storage: SqliteStorage,
  authorize: (signal?: AbortSignal) => Promise<void>,
) {
  const allow = async (signal?: AbortSignal) => {
    if (
      !binding.group_session ||
      binding.execution_authority !== 'miniclaw-product'
    )
      throw new CloudError(403, 'CLOUD_MEMBER_NOT_AVAILABLE');
    await authorize(signal);
  };
  const ask = defineTool({
    name: 'ask_group_dot',
    description:
      'Ask one authorized participant a necessary public Group question. Returns durable admission only; continue independent work and consume the actual reply at a native boundary. Never poll or broadcast.',
    parameters: Type.Object({
      recipient_profile_id: Type.String({ format: 'uuid' }),
      message: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      await allow(context.abortSignal);
      const source = await cloudMemberSource(storage, api, 'tool', {
        active: () => !context.abortSignal?.aborted,
        authorize: () => allow(context.abortSignal),
      });
      const parameters = {
        recipient_profile_id: args.recipient_profile_id,
        message: args.message,
      };
      const identity = {
        kind: 'group_member_tool' as const,
        id: `task:${api.taskId}`,
        task_id: api.taskId,
        call_id: api.callId,
        name: 'ask_group_dot' as const,
        parameters,
        parameters_digest: await digest(JSON.stringify(parameters)),
        source,
      };
      const receipt = async (
        phase: 'prepare' | 'send',
        candidate?: z.infer<typeof MemberSendBindingSchema>,
      ) => {
        const value = await productTool(
          env,
          binding,
          objectId,
          JSON.stringify({
            ...identity,
            phase,
            ...(candidate ? { binding: candidate } : {}),
          }),
          context.abortSignal,
        );
        return z
          .object({
            id: z.literal(identity.id),
            task_id: z.literal(api.taskId),
            call_id: z.literal(api.callId),
            parameters_digest: z.literal(identity.parameters_digest),
            output: z.unknown(),
          })
          .strict()
          .parse(value).output;
      };
      let saved = await api.memo('miniclaw.member.send.v1', context);
      if (saved === undefined) {
        const candidate = MemberSendBindingSchema.parse(
          await receipt('prepare'),
        );
        saved = await api.memo('miniclaw.member.send.v1', candidate, context);
      }
      const committed = MemberSendBindingSchema.parse(saved);
      if (
        committed.source_session_id !== binding.session_id ||
        committed.group_id !== binding.group_session!.group_id ||
        committed.sender_profile_id !== binding.group_session!.profile_id ||
        committed.owner_user_id !== binding.owner_user_id ||
        committed.source_task_id !== api.taskId ||
        committed.source_generation_id !== source.generationTaskId ||
        committed.source_call_id !== api.callId ||
        committed.recipient_profile_id !== parameters.recipient_profile_id ||
        committed.content !== parameters.message ||
        JSON.stringify(committed.source_inputs) !==
          JSON.stringify(source.inputs)
      )
        throw new CloudError(409, 'CLOUD_MEMBER_TOOL_MEMO_CONFLICT');
      await allow(context.abortSignal);
      const output = z
        .object({
          message_id: z.literal(committed.id),
          canonical_message_id: z.string().min(1),
          recipient_profile_id: z.literal(parameters.recipient_profile_id),
          state: z.string(),
          admission_only: z.literal(true),
        })
        .strict()
        .parse(await receipt('send', committed));
      await allow(context.abortSignal);
      return {
        output: [{ type: 'text' as const, text: JSON.stringify(output) }],
      };
    },
  });
  const read = defineTool({
    name: 'read_group_context',
    description:
      'Read only the public Group inputs already placed in this native generation. Does not poll queued replies or read private sessions, Memory or devices.',
    parameters: Type.Object({}),
    replay: 'safe',
    async execute(_args, api, context) {
      await allow(context.abortSignal);
      const source = await cloudMemberSource(storage, api, 'tool', {
        active: () => !context.abortSignal?.aborted,
        authorize: () => allow(context.abortSignal),
      });
      const parameters = {};
      const identity = {
        kind: 'group_member_tool',
        id: `task:${api.taskId}`,
        task_id: api.taskId,
        call_id: api.callId,
        name: 'read_group_context',
        phase: 'read',
        parameters,
        parameters_digest: await digest(JSON.stringify(parameters)),
        source,
      };
      const result = z
        .object({
          id: z.literal(identity.id),
          task_id: z.literal(api.taskId),
          call_id: z.literal(api.callId),
          parameters_digest: z.literal(identity.parameters_digest),
          output: z
            .object({
              group_id: z.literal(binding.group_session!.group_id),
              run_id: z.uuid(),
              native_task_id: z.literal(api.taskId),
              inputs: z
                .array(
                  z
                    .object({
                      request_id: z.string(),
                      submission_id: z.number().int().positive(),
                      context: z.unknown(),
                    })
                    .strict(),
                )
                .min(1)
                .max(64),
            })
            .strict(),
        })
        .strict()
        .parse(
          await productTool(
            env,
            binding,
            objectId,
            JSON.stringify(identity),
            context.abortSignal,
          ),
        );
      if (
        JSON.stringify(
          result.output.inputs.map((i) => [i.request_id, i.submission_id]),
        ) !==
        JSON.stringify(source.inputs.map((i) => [i.requestId, i.submissionId]))
      )
        throw new CloudError(409, 'CLOUD_MEMBER_CONTEXT_SOURCE_CONFLICT');
      await allow(context.abortSignal);
      return {
        output: [
          { type: 'text' as const, text: JSON.stringify(result.output) },
        ],
      };
    },
  });
  return [ask, read];
}
