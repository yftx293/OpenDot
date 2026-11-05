import {
  defineTool,
  type ToolExecutionApi,
  type TaskId,
} from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { productTool, type AuthorityEnvironment } from './authority';
import { CloudError, digest, type SessionBinding } from './protocol';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import {
  CloudMemberEffectProofSchema,
  type CloudMemberExecution,
} from './member-protocol';
import { cloudMemberSource } from './member-source';
import type {
  CloudArtifactIntent,
  CloudExecutionRef,
} from '../../../src/personal-agent/cloud-wire.js';
export const ARTIFACT_MEMO = 'miniclaw.cloud.artifact.intent.v1';
export const ARTIFACT_RECEIPT_MEMO = 'miniclaw.cloud.artifact.receipt.v1';
export const ArtifactIdentitySchema = z
  .object({
    approval_id: z.uuid(),
    parameters_digest: z.string().regex(/^[a-f0-9]{64}$/),
    content_digest: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.string(),
  })
  .strict();
const ArtifactReceiptSchema = ArtifactIdentitySchema.extend({
  state: z.enum([
    'pending',
    'approved',
    'denied',
    'executing',
    'completed',
    'uncertain',
  ]),
});
export type ArtifactIdentity = z.infer<typeof ArtifactIdentitySchema>;
function artifactIdentity(value: ArtifactIdentity): ArtifactIdentity {
  return ArtifactIdentitySchema.parse({
    approval_id: value.approval_id,
    parameters_digest: value.parameters_digest,
    content_digest: value.content_digest,
    expires_at: value.expires_at,
  });
}
export interface ArtifactToolHost {
  park(
    intent: CloudArtifactIntent,
    receipt: ArtifactIdentity,
    kind: 'approval' | 'receipt',
    signal?: AbortSignal,
  ): Promise<never>;
  complete(taskId: number): void;
  block(): void;
}
const rejectedByCorrection = (error: unknown) =>
  error instanceof CloudError &&
  error.status === 409 &&
  error.code === 'GROUP_MEMBER_CONTROL_NOT_CONSUMED';
function correctionResult(host: ArtifactToolHost, taskId: number) {
  host.complete(taskId);
  return {
    isError: true,
    output: [
      {
        type: 'text' as const,
        text: 'The user changed the instruction before this artifact could be authorized. No effect was executed; follow the new instruction at the native input boundary.',
      },
    ],
  };
}
export async function artifactPhase(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  intent: CloudArtifactIntent,
  phase: 'probe' | 'propose' | 'status' | 'execute',
  receipt?: ArtifactIdentity,
  signal?: AbortSignal,
) {
  const response = z
    .object({
      id: z.literal(intent.id),
      task_id: z.literal(intent.task_id),
      call_id: z.literal(intent.call_id),
      parameters_digest: z.literal(intent.parameters_digest),
      output: z.union([
        z.object({ state: z.literal('missing') }).strict(),
        ArtifactReceiptSchema,
      ]),
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
          ...(receipt ? { approval_id: receipt.approval_id } : {}),
        }),
        signal,
      ),
    );
  if (
    receipt &&
    (response.output.state === 'missing' ||
      JSON.stringify(artifactIdentity(response.output)) !==
        JSON.stringify(receipt))
  )
    throw new CloudError(409, 'CLOUD_APPROVAL_IDENTITY_CONFLICT');
  return response.output;
}
export async function generation(
  api: ToolExecutionApi,
  context: Parameters<ToolExecutionApi['getTask']>[1],
) {
  let current = api.taskId;
  const seen = new Set<number>();
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const task = await api.getTask(current, context);
    if (
      !task ||
      task.conversationId !== 1 ||
      task.background ||
      task.abortRequested ||
      ['terminal', 'completing'].includes(task.state.status)
    )
      throw new CloudError(409, 'CLOUD_TOOL_TASK_UNAVAILABLE');
    if (task.owner === undefined) return Number(task.id);
    current = task.owner as TaskId;
  }
  throw new CloudError(409, 'CLOUD_TOOL_TASK_UNAVAILABLE');
}
export function approvedArtifactTool(
  env: AuthorityEnvironment,
  binding: SessionBinding,
  objectId: string,
  authorize: (signal?: AbortSignal) => Promise<void>,
  host: ArtifactToolHost,
  execution?: CloudExecutionRef,
  member?: { execution: CloudMemberExecution; storage: SqliteStorage },
) {
  return defineTool({
    name: 'create_approved_artifact',
    description:
      'Propose a private UTF-8 result artifact (64 KiB maximum). Execution waits for explicit approval of this exact content. Cannot overwrite files or choose a filesystem path.',
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 65536 }),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      await authorize(context.abortSignal);
      if (
        api.conversationId !== 1 ||
        !(
          member?.execution.tool_capabilities ?? binding.tool_capabilities
        )?.includes('create_approved_artifact') ||
        binding.execution_authority !== 'miniclaw-product'
      )
        throw new CloudError(403, 'CLOUD_TOOL_NOT_GRANTED');
      const memberProof =
        member &&
        CloudMemberEffectProofSchema.parse({
          version: 1,
          execution: member.execution,
          source: await cloudMemberSource(member.storage, api, 'tool', {
            active: () => !context.abortSignal?.aborted,
            authorize: () => authorize(context.abortSignal),
          }),
        });
      const parameters = { content: args.content };
      const intent = {
        id: `task:${api.taskId}`,
        conversation_id: 1,
        task_id: api.taskId,
        generation_task_id:
          memberProof?.source.generationTaskId ??
          (await generation(api, context)),
        call_id: api.callId,
        name: 'create_approved_artifact',
        parameters,
        parameters_digest: await digest(JSON.stringify(parameters)),
        ...(execution ? { execution: { ...execution } } : {}),
        ...(memberProof ? { member: memberProof } : {}),
      } satisfies CloudArtifactIntent;
      let committed = await api.memo(ARTIFACT_MEMO, context);
      if (committed === undefined) {
        // If Node already has this task, recreating a missing native memo would
        // turn a product/DO restore mismatch into blind side-effect recovery.
        const prior = await artifactPhase(
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
          throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
        }
        committed = await api.memo(ARTIFACT_MEMO, { ...intent }, context);
      }
      if (JSON.stringify(committed) !== JSON.stringify(intent)) {
        host.block();
        throw new CloudError(409, 'CLOUD_APPROVAL_INTENT_CONFLICT');
      }
      const saved = await api.memo(ARTIFACT_RECEIPT_MEMO, context);
      let identity: ArtifactIdentity | undefined;
      if (saved !== undefined) {
        const parsed = ArtifactIdentitySchema.safeParse(saved);
        if (!parsed.success) {
          host.block();
          throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
        }
        identity = parsed.data;
      }
      let current;
      try {
        current = await artifactPhase(
          env,
          binding,
          objectId,
          intent,
          identity ? 'status' : 'propose',
          identity,
          context.abortSignal,
        );
      } catch (error) {
        if (memberProof && rejectedByCorrection(error))
          return correctionResult(host, api.taskId);
        if (identity)
          return host.park(intent, identity, 'receipt', context.abortSignal);
        // No approved effect can precede the receipt memo. Retain an observable
        // blocked fence if transport cannot establish the original association.
        host.block();
        throw error;
      }
      if (current.state === 'missing') {
        host.block();
        throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
      }
      if (
        !identity &&
        ['executing', 'completed', 'uncertain'].includes(current.state)
      ) {
        host.block();
        throw new CloudError(409, 'CLOUD_APPROVAL_CHECKPOINT_MISSING');
      }
      identity = artifactIdentity(current);
      const stable = await api.memo(
        ARTIFACT_RECEIPT_MEMO,
        { ...identity },
        context,
      );
      if (JSON.stringify(stable) !== JSON.stringify(identity)) {
        host.block();
        throw new CloudError(409, 'CLOUD_APPROVAL_IDENTITY_CONFLICT');
      }
      if (current.state === 'pending')
        return host.park(intent, identity, 'approval', context.abortSignal);
      if (current.state === 'uncertain') {
        host.block();
        throw new CloudError(409, 'CLOUD_APPROVAL_EFFECT_UNCERTAIN');
      }
      if (current.state === 'denied') {
        host.complete(api.taskId);
        return {
          isError: true,
          output: [
            {
              type: 'text' as const,
              text: 'The user denied this artifact or its original execution grant expired.',
            },
          ],
        };
      }
      try {
        current = await artifactPhase(
          env,
          binding,
          objectId,
          intent,
          'execute',
          identity,
          context.abortSignal,
        );
      } catch (error) {
        if (memberProof && rejectedByCorrection(error))
          return correctionResult(host, api.taskId);
        return host.park(intent, identity, 'receipt', context.abortSignal);
      }
      if (current.state !== 'completed') {
        host.block();
        throw new CloudError(409, 'CLOUD_APPROVAL_EFFECT_UNCERTAIN');
      }
      await authorize(context.abortSignal);
      host.complete(api.taskId);
      return {
        output: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              artifactId: current.approval_id,
              contentDigest: current.content_digest,
              state: current.state,
            }),
          },
        ],
      };
    },
  });
}
