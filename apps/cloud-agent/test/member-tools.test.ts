// Native Cloud tool + signed authority fixture, not product Group acceptance.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  Harness,
  createRegistry,
  defineExtension,
  type TaskId,
} from '@earendil-works/pi-durable';
import { openPiSessionStore } from 'agents/harness/pi';
import { cloudMemberTools } from '../src/member-tools';
import { productTool } from '../src/authority';
import { authenticate, digest, type SessionBinding } from '../src/protocol';
import {
  CloudMemberToolRequestSchema,
  MemberSendBindingSchema,
} from '../src/member-protocol';
import type { Env } from '../src/worker';

test.each([
  [
    'prepare-hop',
    'peer',
    'prepare',
    true,
    409,
    'GROUP_MEMBER_HOP_LIMIT',
    409,
    'GROUP_MEMBER_HOP_LIMIT',
  ],
  [
    'send-inbox',
    'peer',
    'send',
    true,
    409,
    'GROUP_MEMBER_INBOX_LIMIT',
    409,
    'GROUP_MEMBER_INBOX_LIMIT',
  ],
  [
    'recipient',
    'peer',
    'prepare',
    true,
    409,
    'GROUP_MEMBER_RECIPIENT_UNAVAILABLE',
    409,
    'GROUP_MEMBER_RECIPIENT_UNAVAILABLE',
  ],
  [
    'message-bytes',
    'peer',
    'prepare',
    true,
    409,
    'GROUP_MEMBER_MESSAGE_LIMIT',
    409,
    'GROUP_MEMBER_MESSAGE_LIMIT',
  ],
  [
    'message-budget',
    'peer',
    'send',
    true,
    409,
    'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED',
    409,
    'GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED',
  ],
  [
    'expired',
    'peer',
    'prepare',
    true,
    409,
    'GROUP_MEMBER_DELIVERY_EXPIRED',
    409,
    'GROUP_MEMBER_DELIVERY_EXPIRED',
  ],
  [
    'unknown',
    'peer',
    'prepare',
    true,
    409,
    'PRIVATE_DENIAL_BODY_CANARY',
    503,
    'CLOUD_TOOL_UNAVAILABLE',
  ],
  [
    'transport',
    'peer',
    'prepare',
    true,
    503,
    'GROUP_MEMBER_HOP_LIMIT',
    503,
    'CLOUD_TOOL_UNAVAILABLE',
  ],
  [
    'private-binding',
    'peer',
    'prepare',
    false,
    409,
    'GROUP_MEMBER_HOP_LIMIT',
    503,
    'CLOUD_TOOL_UNAVAILABLE',
  ],
  [
    'artifact-uncertainty',
    'artifact',
    'execute',
    true,
    409,
    'GROUP_MEMBER_HOP_LIMIT',
    503,
    'CLOUD_TOOL_UNAVAILABLE',
  ],
  [
    'read-not-admission',
    'read',
    'read',
    true,
    409,
    'GROUP_MEMBER_HOP_LIMIT',
    503,
    'CLOUD_TOOL_UNAVAILABLE',
  ],
  [
    'malformed-request',
    'bad-json',
    'prepare',
    true,
    409,
    'GROUP_MEMBER_HOP_LIMIT',
    503,
    'CLOUD_TOOL_UNAVAILABLE',
  ],
  [
    'existing-control-fence',
    'artifact',
    'execute',
    true,
    409,
    'GROUP_MEMBER_CONTROL_NOT_CONSUMED',
    409,
    'GROUP_MEMBER_CONTROL_NOT_CONSUMED',
  ],
] as const)(
  'transport rejection mapping and redaction: %s',
  async (
    _mode,
    caller,
    phase,
    group,
    status,
    code,
    expectedStatus,
    expectedCode,
  ) => {
    const groupId = crypto.randomUUID(),
      profileId = crypto.randomUUID(),
      recipientId = crypto.randomUUID();
    const binding: SessionBinding = {
      version: 1,
      session_id: crypto.randomUUID(),
      runtime_id: crypto.randomUUID(),
      owner_user_id: 'alice',
      workspace_jid: 'web:alice',
      config_fingerprint: 'a'.repeat(64),
      provider_id: 'fixture',
      model_id: 'fixture',
      instructions: '',
      deadline_at: Date.now() + 60000,
      max_model_steps: 4,
      execution_authority: 'miniclaw-product',
      tool_capabilities: [],
      ...(group
        ? { group_session: { group_id: groupId, profile_id: profileId } }
        : {}),
    };
    const parameters = {
      recipient_profile_id: recipientId,
      message: 'Review this public preview.',
    };
    const source = {
      conversationId: 1,
      toolTaskId: 2,
      generationTaskId: 1,
      inputs: [{ submissionId: 2, requestId: 'original-request', entryId: 1 }],
    };
    const common = {
      kind: 'group_member_tool',
      id: 'task:2',
      task_id: 2,
      call_id: 'original-call',
      source,
      parameters_digest: await digest(JSON.stringify(parameters)),
    };
    const member = {
      ...common,
      name: caller === 'read' ? 'read_group_context' : 'ask_group_dot',
      parameters: caller === 'read' ? {} : parameters,
      phase,
    };
    const body =
      caller === 'artifact'
        ? JSON.stringify({ name: 'create_approved_artifact', phase })
        : caller === 'bad-json'
          ? '{'
          : JSON.stringify({
              ...member,
              ...(phase === 'send'
                ? {
                    binding: MemberSendBindingSchema.parse({
                      version: 1,
                      id: crypto.randomUUID(),
                      run_id: crypto.randomUUID(),
                      group_id: groupId,
                      owner_user_id: 'alice',
                      sender_profile_id: profileId,
                      recipient_profile_id: recipientId,
                      recipient_session_id: crypto.randomUUID(),
                      source_session_id: binding.session_id,
                      source_input_id: 'original-product-input',
                      source_task_id: 2,
                      source_generation_id: 1,
                      source_call_id: 'original-call',
                      source_inputs: source.inputs,
                      content: parameters.message,
                      hop: 1,
                      deadline_at: Date.now() + 60000,
                      cancel_epoch: 0,
                    }),
                  }
                : {}),
            });
    if (caller === 'peer')
      expect(
        CloudMemberToolRequestSchema.safeParse(JSON.parse(body)).success,
      ).toBe(true);
    const secret = 'safe-member-rejection-fixture-key-32';
    let calls = 0;
    const transport = {
      MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
      MINICLAW_CLOUD_SHARED_SECRET: secret,
      MINICLAW_AUTHORITY_SERVICE: {
        fetch: async (request: Request) => {
          calls++;
          const raw = await request.text();
          expect((await authenticate(request, secret, raw)).session_id).toBe(
            binding.session_id,
          );
          return Response.json(
            { error: code, private_detail: 'PRIVATE_DENIAL_DETAIL_CANARY' },
            { status },
          );
        },
      } as unknown as Fetcher,
    };
    const rejected = await productTool(
      transport,
      binding,
      'b'.repeat(64),
      body,
    ).then(
      () => null,
      (error) => error,
    );
    expect(rejected).toMatchObject({
      status: expectedStatus,
      code: expectedCode,
      message: expectedCode,
    });
    expect(String(rejected)).not.toContain('PRIVATE_DENIAL_BODY_CANARY');
    expect(String(rejected)).not.toContain('PRIVATE_DENIAL_DETAIL_CANARY');
    expect(calls).toBe(1);
  },
);

test.each([
  'ask',
  'forged-binding',
  'read',
  'forged-context',
  'hop-limit',
  'unknown-denial',
] as const)(
  'Cloud peer Tool signed source and effect boundary: %s',
  async (mode) => {
    const forged = mode === 'forged-binding';
    const denied = mode === 'hop-limit' || mode === 'unknown-denial';
    const readOnly = mode === 'read' || mode === 'forged-context';
    const cloud = env as unknown as Env;
    const sessionId = crypto.randomUUID(),
      groupId = crypto.randomUUID(),
      profileId = crypto.randomUUID(),
      recipientId = crypto.randomUUID();
    const binding: SessionBinding = {
      version: 1,
      session_id: sessionId,
      runtime_id: crypto.randomUUID(),
      owner_user_id: 'alice',
      workspace_jid: 'web:alice',
      config_fingerprint: 'a'.repeat(64),
      provider_id: 'fixture',
      model_id: 'fixture',
      instructions: '',
      deadline_at: Date.now() + 60000,
      max_model_steps: 4,
      execution_authority: 'miniclaw-product',
      tool_capabilities: [],
      group_session: { group_id: groupId, profile_id: profileId },
    };
    const secret = 'cloud-member-wire-native-fixture-key-32';
    const calls: { phase: string; source: unknown }[] = [];
    const questions = new Map<string, string>();
    await runInDurableObject(
      cloud.SESSIONS.getByName(`v1:${sessionId}`),
      async (_instance, state) => {
        const storage = await openPiSessionStore(state.storage);
        let chosen:
          | ReturnType<typeof MemberSendBindingSchema.parse>
          | undefined;
        const transport = {
          MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
          MINICLAW_CLOUD_SHARED_SECRET: secret,
          MINICLAW_AUTHORITY_SERVICE: {
            fetch: async (request: Request) => {
              const raw = await request.text();
              expect(await authenticate(request, secret, raw)).toMatchObject({
                session_id: sessionId,
                owner_user_id: 'alice',
                workspace_jid: 'web:alice',
              });
              const input = CloudMemberToolRequestSchema.parse(JSON.parse(raw));
              expect(input.parameters_digest).toBe(
                await digest(JSON.stringify(input.parameters)),
              );
              expect(input.source.toolTaskId).toBe(input.task_id);
              expect(input.source.inputs.map((i) => i.requestId)).toEqual([
                'original-group-request',
              ]);
              if (input.name === 'read_group_context') {
                calls.push({ phase: input.phase, source: input.source });
                return Response.json({
                  id: input.id,
                  task_id: input.task_id,
                  call_id: input.call_id,
                  parameters_digest: input.parameters_digest,
                  output: {
                    group_id: groupId,
                    run_id: crypto.randomUUID(),
                    native_task_id: input.task_id,
                    inputs: input.source.inputs.map((i) => ({
                      request_id:
                        mode === 'forged-context'
                          ? 'future-unplaced-request'
                          : i.requestId,
                      submission_id: i.submissionId,
                      context: {
                        public:
                          mode === 'forged-context'
                            ? 'FUTURE_CONTEXT_CANARY'
                            : 'FROZEN_PUBLIC_ONLY',
                      },
                    })),
                  },
                });
              }
              expect(input.parameters).toEqual({
                recipient_profile_id: recipientId,
                message: 'Review this public preview task.',
              });
              calls.push({ phase: input.phase, source: input.source });
              if (denied)
                return Response.json(
                  {
                    error:
                      mode === 'hop-limit'
                        ? 'GROUP_MEMBER_HOP_LIMIT'
                        : 'PRIVATE_UNKNOWN_DENIAL_CANARY',
                    private_detail: 'PRIVATE_DENIAL_DETAIL_CANARY',
                  },
                  { status: 409 },
                );
              let output;
              if (input.phase === 'prepare') {
                chosen = MemberSendBindingSchema.parse({
                  version: 1,
                  id: crypto.randomUUID(),
                  run_id: crypto.randomUUID(),
                  group_id: groupId,
                  owner_user_id: 'alice',
                  sender_profile_id: forged ? crypto.randomUUID() : profileId,
                  recipient_profile_id: recipientId,
                  recipient_session_id: crypto.randomUUID(),
                  source_session_id: sessionId,
                  source_input_id: 'product-input-fixture',
                  source_task_id: input.task_id,
                  source_generation_id: input.source.generationTaskId,
                  source_call_id: input.call_id,
                  source_inputs: input.source.inputs,
                  content: input.parameters.message,
                  hop: 1,
                  deadline_at: Date.now() + 60000,
                  cancel_epoch: 0,
                });
                output = chosen;
              } else {
                expect(input.binding).toEqual(chosen);
                // Verify before the authority admits a mail. Pi may discard
                // terminal Tool memos after successful completion.
                expect(
                  (await storage.task(input.task_id as TaskId, BG))?.memos?.[
                    'miniclaw.member.send.v1'
                  ],
                ).toEqual(chosen);
                const serialized = JSON.stringify(input.binding),
                  prior = questions.get(input.binding.id);
                if (prior) expect(prior).toBe(serialized);
                else questions.set(input.binding.id, serialized);
                output = {
                  message_id: input.binding.id,
                  canonical_message_id: `group-member:${input.binding.id}`,
                  recipient_profile_id: recipientId,
                  state: 'admitted',
                  admission_only: true,
                };
              }
              return Response.json({
                id: input.id,
                task_id: input.task_id,
                call_id: input.call_id,
                parameters_digest: input.parameters_digest,
                output,
              });
            },
          } as unknown as Fetcher,
        };
        const tools = cloudMemberTools(
          transport,
          binding,
          'b'.repeat(64),
          storage,
          async (signal) => {
            signal?.throwIfAborted();
          },
        );
        const faux = fauxProvider(),
          models = createModels(),
          registry = createRegistry();
        models.setProvider(faux.provider);
        const extension = defineExtension({
          name: 'cloud-peer-wire-capability',
          tools,
        });
        registry.install(extension);
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall(
              readOnly ? 'read_group_context' : 'ask_group_dot',
              readOnly
                ? {}
                : {
                    recipient_profile_id: recipientId,
                    message: 'Review this public preview task.',
                  },
            ),
            { stopReason: 'toolUse' },
          ),
          (context) => {
            const text = JSON.stringify(context.messages);
            if (denied) {
              expect(text).toContain(
                mode === 'hop-limit'
                  ? 'GROUP_MEMBER_HOP_LIMIT'
                  : 'CLOUD_TOOL_UNAVAILABLE',
              );
              expect(text).not.toContain('PRIVATE_UNKNOWN_DENIAL_CANARY');
              expect(text).not.toContain('PRIVATE_DENIAL_DETAIL_CANARY');
            } else if (forged)
              expect(text).toContain('CLOUD_MEMBER_TOOL_MEMO_CONFLICT');
            else if (mode === 'forged-context') {
              expect(text).toContain('CLOUD_MEMBER_CONTEXT_SOURCE_CONFLICT');
              expect(text).not.toContain('FUTURE_CONTEXT_CANARY');
            } else
              expect(text).toContain(
                readOnly ? 'FROZEN_PUBLIC_ONLY' : 'admission_only',
              );
            return fauxAssistantMessage(
              forged ? 'FORGED_BINDING_REJECTED' : 'ADMISSION_IS_NOT_A_REPLY',
            );
          },
        ]);
        const selected = faux.getModel();
        const harness = await Harness.open(
          storage,
          {
            models,
            registry,
            settings: {
              compaction: { enabled: false },
              retry: { enabled: false },
            },
          },
          BG,
        );
        try {
          const root = await harness.root(BG, {
            agent: {
              model: { provider: selected.provider, modelId: selected.id },
              extensions: [extension],
              tools,
            },
          });
          const request = await root.submit(
            {
              type: 'input',
              requestId: 'original-group-request',
              content: 'Review the preview task.',
              whenBusy: 'followUp',
            },
            BG,
          );
          expect((await request.wait(BG)).status).toBe('done');
          expect(calls.map((c) => c.phase)).toEqual(
            readOnly
              ? ['read']
              : forged || denied
                ? ['prepare']
                : ['prepare', 'send'],
          );
          expect(questions.size).toBe(readOnly || forged || denied ? 0 : 1);
          expect(faux.state.callCount).toBe(2);
          console.info(
            'CLOUD_PEER_WIRE_PROOF ' +
              JSON.stringify({
                tier: 'raw-workerd-native-tool+signed-fixture-authority',
                mode,
                phases: calls.map((c) => c.phase),
                questions: questions.size,
                model_calls: faux.state.callCount,
                source: calls[0]?.source,
              }),
          );
        } finally {
          await harness.close(BG);
        }
      },
    );
  },
  30000,
);
