import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { defineTool, type TaskId } from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { CloudError, digest, type SessionBinding } from './protocol';
import { productTool, type AuthorityEnvironment } from './authority';
import { generation } from './artifact-tool';
import {
  CLOUD_DEVICE_INTENT_MEMO,
  CLOUD_DEVICE_RECEIPT_MEMO,
  CLOUD_DEVICE_GRANT_MEMO,
  CLOUD_DEVICE_RESULT_MEMO,
  CloudDeviceIntentSchema,
  CloudDeviceIdentitySchema,
  CloudDeviceGrantReceiptSchema,
  CloudDeviceResponseSchema,
  type CloudDeviceIntent,
  type CloudDeviceIdentity,
  type CloudDeviceProof,
} from './device-protocol';
export interface DeviceToolHost {
  park(
    intent: CloudDeviceIntent,
    receipt: CloudDeviceIdentity,
    kind: 'permission' | 'device',
    signal?: AbortSignal,
  ): Promise<never>;
  complete(taskId: number): void;
  block(): void;
}
/** A pure committed-storage proof: never opens a second Harness, starts
 * Lifecycle, fetches a model or trusts browser-supplied native identities. */
export async function verifyCloudDeviceProof(
  storage: SqliteStorage,
  binding: SessionBinding,
  proof: CloudDeviceProof,
) {
  const { intent, receipt, grant } = proof;
  if (
    !binding.bot_handoff ||
    binding.execution_authority !== 'miniclaw-product' ||
    !binding.tool_capabilities?.includes('read_device_file') ||
    receipt.cloud_session_id !== binding.session_id ||
    receipt.owner_user_id !== binding.owner_user_id ||
    receipt.workspace_jid !== binding.workspace_jid ||
    receipt.handoff_id !== binding.bot_handoff.handoff_id ||
    receipt.node_id !== intent.parameters.node_id ||
    receipt.path !== intent.parameters.path ||
    intent.id !== `task:${intent.task_id}` ||
    intent.parameters_digest !==
      (await digest(JSON.stringify(intent.parameters)))
  )
    throw new CloudError(409, 'CLOUD_DEVICE_SCOPE_CONFLICT');
  const task = await storage.task(intent.task_id as TaskId, BG);
  if (
    !task ||
    task.conversationId !== 1 ||
    task.abortRequested ||
    task.background ||
    ['terminal', 'completing'].includes(task.state.status) ||
    JSON.stringify(task.memos?.[CLOUD_DEVICE_INTENT_MEMO]) !==
      JSON.stringify(intent)
  )
    throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
  if (task.memos?.[CLOUD_DEVICE_RECEIPT_MEMO] === undefined) return false;
  if (
    JSON.stringify(task.memos[CLOUD_DEVICE_RECEIPT_MEMO]) !==
    JSON.stringify(receipt)
  )
    throw new CloudError(409, 'CLOUD_DEVICE_RECEIPT_CONFLICT');
  if (grant) {
    if (task.memos?.[CLOUD_DEVICE_GRANT_MEMO] === undefined) return false;
    if (
      JSON.stringify(task.memos[CLOUD_DEVICE_GRANT_MEMO]) !==
      JSON.stringify(grant)
    )
      throw new CloudError(409, 'CLOUD_DEVICE_GRANT_CONFLICT');
  }
  let current = task;
  const seen = new Set<number>();
  for (let depth = 0; depth < 32; depth++) {
    if (
      seen.has(current.id) ||
      current.conversationId !== 1 ||
      current.abortRequested ||
      current.background ||
      ['terminal', 'completing'].includes(current.state.status)
    )
      throw new CloudError(409, 'CLOUD_DEVICE_TASK_SCOPE_CONFLICT');
    seen.add(current.id);
    if (current.owner === undefined) {
      if (Number(current.id) !== intent.generation_task_id)
        throw new CloudError(409, 'CLOUD_DEVICE_TASK_SCOPE_CONFLICT');
      return true;
    }
    const owner = await storage.task(current.owner, BG);
    if (!owner) throw new CloudError(409, 'CLOUD_DEVICE_TASK_SCOPE_CONFLICT');
    current = owner;
  }
  throw new CloudError(409, 'CLOUD_DEVICE_TASK_SCOPE_CONFLICT');
}
export async function devicePhase(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  intent: CloudDeviceIntent,
  phase: 'probe' | 'propose' | 'status' | 'consume' | 'confirm',
  receipt?: CloudDeviceIdentity,
  signal?: AbortSignal,
  resultDigest?: string,
) {
  const response = z
    .object({
      id: z.literal(intent.id),
      task_id: z.literal(intent.task_id),
      call_id: z.literal(intent.call_id),
      parameters_digest: z.literal(intent.parameters_digest),
      output: CloudDeviceResponseSchema,
    })
    .strict()
    .parse(
      await productTool(
        env,
        binding,
        objectId,
        JSON.stringify({
          ...intent,
          phase,
          ...(receipt ? { receipt } : {}),
          ...(resultDigest ? { result_digest: resultDigest } : {}),
        }),
        signal,
      ),
    );
  if (response.output.state !== 'missing') {
    const identity = response.output.identity;
    if (
      identity.cloud_session_id !== binding.session_id ||
      identity.handoff_id !== binding.bot_handoff?.handoff_id ||
      identity.owner_user_id !== binding.owner_user_id ||
      identity.workspace_jid !== binding.workspace_jid ||
      identity.node_id !== intent.parameters.node_id ||
      identity.path !== intent.parameters.path ||
      (receipt && JSON.stringify(identity) !== JSON.stringify(receipt))
    )
      throw new CloudError(409, 'CLOUD_DEVICE_IDENTITY_CONFLICT');
  } else if (receipt)
    throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
  return response.output;
}
export function localDeviceReadTool(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  authorize: (signal?: AbortSignal) => Promise<void>,
  host: DeviceToolHost,
) {
  return defineTool({
    name: 'read_device_file',
    description:
      'Request one explicitly declared UTF-8 file from one paired local device. Requires separate exact-request user authorization; offline devices wait without using another environment. Request one file at a time. Cannot execute shell commands, discover arbitrary paths, or write files.',
    parameters: Type.Object({
      node_id: Type.String({ format: 'uuid' }),
      path: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      await authorize(context.abortSignal);
      if (
        !binding.bot_handoff ||
        binding.goal_id ||
        binding.execution_authority !== 'miniclaw-product' ||
        !binding.tool_capabilities?.includes('read_device_file') ||
        api.conversationId !== 1
      )
        throw new CloudError(403, 'CLOUD_TOOL_NOT_GRANTED');
      const parameters = { node_id: args.node_id, path: args.path };
      const intent = CloudDeviceIntentSchema.parse({
        id: `task:${api.taskId}`,
        conversation_id: 1,
        task_id: api.taskId,
        generation_task_id: await generation(api, context),
        call_id: api.callId,
        name: 'read_device_file',
        parameters,
        parameters_digest: await digest(JSON.stringify(parameters)),
      });
      const existing = await api.memo(CLOUD_DEVICE_INTENT_MEMO, context);
      if (existing === undefined) {
        const prior = await devicePhase(
          env,
          binding,
          objectId,
          intent,
          'probe',
          undefined,
          context.abortSignal,
        );
        if (prior.state !== 'missing') {
          host.block();
          throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
        }
      } else if (JSON.stringify(existing) !== JSON.stringify(intent)) {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_INTENT_CONFLICT');
      }
      const stored = await api.memo(
        CLOUD_DEVICE_INTENT_MEMO,
        { ...intent },
        context,
      );
      if (JSON.stringify(stored) !== JSON.stringify(intent)) {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_INTENT_CONFLICT');
      }
      const saved = await api.memo(CLOUD_DEVICE_RECEIPT_MEMO, context);
      let identity =
        saved === undefined
          ? undefined
          : CloudDeviceIdentitySchema.parse(saved);
      if (identity && identity.deadline_at <= Date.now()) {
        host.complete(api.taskId);
        return {
          isError: true,
          output: [
            {
              type: 'text' as const,
              text: 'The exact device request expired without a confirmed result. No alternate device or environment was used.',
            },
          ],
        };
      }
      let current;
      try {
        current = await devicePhase(
          env,
          binding,
          objectId,
          intent,
          identity ? 'status' : 'propose',
          identity,
          context.abortSignal,
        );
      } catch (error) {
        if (identity)
          return host.park(
            intent,
            identity,
            (await api.memo(CLOUD_DEVICE_GRANT_MEMO, context)) === undefined
              ? 'permission'
              : 'device',
            context.abortSignal,
          );
        host.block();
        throw error;
      }
      if (current.state === 'missing') {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_CHECKPOINT_MISSING');
      }
      identity = current.identity;
      const stable = await api.memo(
        CLOUD_DEVICE_RECEIPT_MEMO,
        { ...identity },
        context,
      );
      if (JSON.stringify(stable) !== JSON.stringify(identity)) {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_IDENTITY_CONFLICT');
      }
      if (!current.grant)
        return host.park(intent, identity, 'permission', context.abortSignal);
      const grant = CloudDeviceGrantReceiptSchema.parse(current.grant),
        committed = await api.memo(
          CLOUD_DEVICE_GRANT_MEMO,
          { ...grant },
          context,
        );
      if (JSON.stringify(committed) !== JSON.stringify(grant)) {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_GRANT_CONFLICT');
      }
      if (['waiting_for_device', 'dispatched'].includes(current.state))
        return host.park(intent, identity, 'device', context.abortSignal);
      if (current.state === 'cancelled') {
        host.complete(api.taskId);
        return {
          isError: true,
          output: [
            {
              type: 'text' as const,
              text: 'The authorized local device request was cancelled.',
            },
          ],
        };
      }
      try {
        current = await devicePhase(
          env,
          binding,
          objectId,
          intent,
          'consume',
          identity,
          context.abortSignal,
        );
      } catch {
        return host.park(intent, identity, 'device', context.abortSignal);
      }
      if (
        current.state === 'missing' ||
        !current.result ||
        !['completed', 'failed'].includes(current.state)
      )
        throw new CloudError(409, 'CLOUD_DEVICE_RESULT_UNCONFIRMED');
      if (
        current.result.ok &&
        (await digest(current.result.content)) !== current.result.content_digest
      ) {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_RESULT_CONFLICT');
      }
      const resultDigest = await digest(JSON.stringify(current.result));
      const resultMemo = await api.memo(
        CLOUD_DEVICE_RESULT_MEMO,
        { result_digest: resultDigest },
        context,
      );
      if (
        JSON.stringify(resultMemo) !==
        JSON.stringify({ result_digest: resultDigest })
      ) {
        host.block();
        throw new CloudError(409, 'CLOUD_DEVICE_RESULT_CONFLICT');
      }
      try {
        await devicePhase(
          env,
          binding,
          objectId,
          intent,
          'confirm',
          identity,
          context.abortSignal,
          resultDigest,
        );
      } catch {
        return host.park(intent, identity, 'device', context.abortSignal);
      }
      await authorize(context.abortSignal);
      host.complete(api.taskId);
      return {
        isError: !current.result.ok,
        output: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              deviceId: identity.node_id,
              path: identity.path,
              commandId: identity.request_id,
              ...current.result,
            }),
          },
        ],
      };
    },
  });
}
