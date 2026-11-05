import {
  CloudMemberModelProofSchema,
  type CloudMemberExecution,
  type CloudMemberModelProof,
} from './member-protocol';
import { cloudMemberSource } from './member-source';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { cloudMemberTools } from './member-tools';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  GenerationTask,
  ROOT_CONVERSATION_ID,
  section,
} from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createCloudModels, type ModelEnvironment } from './models';
import { digest, type SessionBinding } from './protocol';
import { personalMemoryTool } from './tools';
import { approvedArtifactTool, type ArtifactToolHost } from './artifact-tool';
import { localDeviceReadTool, type DeviceToolHost } from './device-tool';
import type { CloudExecutionGrant } from '../../../src/personal-agent/cloud-wire.js';
import { executionRef } from './execution-protocol';
export async function openCloudHarness(
  storage: SqliteStorage,
  objectId: string,
  env: ModelEnvironment,
  binding: SessionBinding,
  authorize: (signal?: AbortSignal) => Promise<void>,
  charge: () => void,
  onCommit: () => void,
  verify: (harness: Harness) => Promise<void>,
  options: {
    member?: CloudMemberExecution;
    memberOwnerRevision?: number;
    artifactHost?: ArtifactToolHost;
    deviceHost?: DeviceToolHost;
    initialAuthorize?: () => Promise<void>;
    execution?: CloudExecutionGrant;
    modelInterrupted?: (signal: AbortSignal) => Promise<never>;
  } = {},
) {
  await (options.initialAuthorize ?? authorize)();
  const tool = defineTool({
    name: 'inspect_text',
    description:
      'Count UTF-8 bytes and SHA256 of the provided text. Safe read-only computation; no file, shell, network or account access.',
    parameters: Type.Object({ text: Type.String({ maxLength: 32768 }) }),
    replay: 'safe',
    async execute({ text }, _api, context) {
      await authorize(context.abortSignal);
      const result = {
        bytes: new TextEncoder().encode(text).length,
        sha256: await digest(text),
      };
      await authorize(context.abortSignal);
      return { output: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  });
  const selectedCapabilities =
    options.member?.tool_capabilities ?? binding.tool_capabilities;
  const tools = [
    ...(binding.execution_authority === 'miniclaw-product' &&
    binding.bot_handoff &&
    selectedCapabilities?.includes('read_device_file') &&
    options.deviceHost
      ? [
          localDeviceReadTool(
            env,
            binding,
            objectId,
            authorize,
            options.deviceHost,
          ),
        ]
      : []),
    ...(!(binding.bot_handoff || binding.group_session) ||
    selectedCapabilities?.includes('inspect_text')
      ? [tool]
      : []),
    ...(binding.execution_authority === 'miniclaw-product' &&
    selectedCapabilities?.includes('read_personal_memory')
      ? [
          personalMemoryTool(
            env,
            binding,
            objectId,
            authorize,
            options.execution && executionRef(options.execution),
          ),
        ]
      : []),
    ...(binding.execution_authority === 'miniclaw-product' &&
    selectedCapabilities?.includes('create_approved_artifact') &&
    options.artifactHost
      ? [
          approvedArtifactTool(
            env,
            binding,
            objectId,
            authorize,
            options.artifactHost,
            options.execution && executionRef(options.execution),
            options.member ? { execution: options.member, storage } : undefined,
          ),
        ]
      : []),
  ];
  const peerDefinitions =
    binding.group_session && binding.execution_authority === 'miniclaw-product'
      ? cloudMemberTools(env, binding, objectId, storage, authorize)
      : [];
  const memberFrames = new Map<string, CloudMemberModelProof>();
  const selectedTools = options.member ? [...tools, ...peerDefinitions] : tools;
  const extension = defineExtension({
    name: 'miniclaw-cloud',
    // Definition availability is not permission; existing Agent.tools below
    // still selects only the legacy binding until a member contract is installed.
    tools: [...tools, ...peerDefinitions],
    sections: [
      section(
        'preamble',
        () =>
          binding.instructions +
          (options.member
            ? '\nCurrent execution contract: member-inbox-v1. Ignore prior serial JSON speaker rules. Use ask_group_dot for necessary public directed questions, consume actual peer replies at native boundaries, and use plain final text. Never poll, broadcast, expose private history or assume extra tool rights.'
            : ''),
        { tag: false },
      ),
    ],
    hooks: options.member
      ? [
          hook(GenerationTask, {
            beforeRequest: async (request, api, context) => {
              memberFrames.clear();
              await authorize(context.abortSignal);
              const source = await cloudMemberSource(
                storage,
                api,
                'generation',
                {
                  active: () => !context.abortSignal?.aborted,
                  authorize: () => authorize(context.abortSignal),
                },
              );
              const key = await digest(
                JSON.stringify(
                  normalizeContext({ messages: [...request.messages] })
                    .messages,
                ),
              );
              memberFrames.set(
                key,
                CloudMemberModelProofSchema.parse({
                  version: 1,
                  owner_revision: options.memberOwnerRevision,
                  execution: options.member,
                  context_digest: key,
                  source: {
                    conversationId: 1,
                    generationTaskId: source.generationTaskId,
                    attempt: source.attempt,
                    inputs: source.inputs,
                  },
                }),
              );
              return undefined;
            },
          }),
        ]
      : [],
  });
  const registry = createRegistry();
  registry.install(extension);
  const configured = createCloudModels(
    env,
    binding,
    async (signal) => {
      await authorize(signal);
      charge();
    },
    objectId,
    options.execution,
    options.modelInterrupted,
    options.member
      ? async (context) => {
          const key = await digest(JSON.stringify(context.messages)),
            frame = memberFrames.get(key);
          memberFrames.delete(key);
          if (!frame) throw new Error('CLOUD_MEMBER_NATIVE_PROOF_REQUIRED');
          return frame;
        }
      : undefined,
  );
  const harness = await Harness.open(
    storage,
    {
      models: configured.models,
      registry,
      settings: {
        toolExecution: selectedCapabilities?.includes(
          'create_approved_artifact',
        )
          ? 'sequential'
          : 'parallel',
        ...(options.member
          ? { steeringMode: 'all', compaction: { enabled: false } }
          : {}),
        documentRetentionMs: 0,
        contextRetentionMs: 0,
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 1000 },
      },
      conversationCreated: (tx, conversation) =>
        configure(tx, conversation.id, {
          model: configured.model,
          thinkingLevel: 'off',
          extensions: [extension],
          tools: selectedTools,
        }),
    },
    BG,
  );
  try {
    await verify(harness);
    if (options.member) {
      const root = await harness.root(BG);
      await root.commit(async (tx) => {
        await configure(tx, ROOT_CONVERSATION_ID, {
          extensions: [extension],
          tools: selectedTools,
        });
      }, BG);
    }
  } catch (error) {
    await harness.close(BG);
    throw error;
  }
  harness.subscribeCommits(onCommit);
  return harness;
}
