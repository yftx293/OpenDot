// Native capability test in real workerd SQLite, not product Group acceptance.
// One explicitly owned Harness; this test does not start CloudSession Lifecycle.
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
import { Type } from '@earendil-works/pi-ai';
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  GenerationTask,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { openPiSessionStore } from 'agents/harness/pi';
import { cloudMemberSource } from '../src/member-source';
import type { Env } from '../src/worker';

test.each(['followUp', 'steer'] as const)(
  'workerd native %s source excludes queued inputs and expires with its owner',
  async (mode) => {
    const cloud = env as unknown as Env;
    const stub = cloud.SESSIONS.getByName(`v1:${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = await openPiSessionStore(state.storage);
      const faux = fauxProvider(),
        models = createModels(),
        registry = createRegistry();
      models.setProvider(faux.provider);
      let active = true,
        allowed = true,
        release!: () => void;
      const authority = {
        active: () => active,
        authorize: () => {
          if (!allowed) throw new Error('live ACL denied');
        },
      };
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sources: Awaited<ReturnType<typeof cloudMemberSource>>[] = [];
      const generations: Awaited<ReturnType<typeof cloudMemberSource>>[] = [];
      let firstSeen!: (
        source: Awaited<ReturnType<typeof cloudMemberSource>>,
      ) => void;
      let firstFailed!: (error: unknown) => void;
      const observed = new Promise<
        Awaited<ReturnType<typeof cloudMemberSource>>
      >((resolve, reject) => {
        firstSeen = resolve;
        firstFailed = reject;
      });
      const tool = defineTool({
        name: 'prove_member_source',
        description: 'Read actual native source IDs.',
        parameters: Type.Object({ label: Type.String() }),
        replay: 'safe',
        async execute(args, api) {
          try {
            const source = await cloudMemberSource(
              storage,
              api,
              'tool',
              authority,
            );
            sources.push(source);
            if (args.label === 'first') {
              firstSeen(source);
              await held;
            }
            return {
              output: [{ type: 'text' as const, text: 'NATIVE_SOURCE_BOUND' }],
            };
          } catch (error) {
            firstFailed(error);
            throw error;
          }
        },
      });
      const extension = defineExtension({
        name: 'cloud-member-source-proof',
        tools: [tool],
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (_request, api) => {
              generations.push(
                await cloudMemberSource(storage, api, 'generation', authority),
              );
              return undefined;
            },
          }),
        ],
      });
      registry.install(extension);
      const selected = faux.getModel();
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(tool.name, { label: 'first' }), {
          stopReason: 'toolUse',
        }),
        ...(mode === 'followUp' ? [fauxAssistantMessage('FIRST_DONE')] : []),
        (context) => {
          expect(JSON.stringify(context.messages)).toContain(
            'Only handle the preview environment.',
          );
          return fauxAssistantMessage(
            fauxToolCall(tool.name, { label: 'second' }),
            { stopReason: 'toolUse' },
          );
        },
        fauxAssistantMessage('SECOND_DONE'),
      ]);
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            steeringMode: 'all',
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
            tools: [tool],
          },
        });
        expect(faux.state.callCount).toBe(0);
        active = false;
        await expect(
          cloudMemberSource(
            storage,
            { conversationId: root.id, taskId: 1 },
            'tool',
            authority,
          ),
        ).rejects.toThrow('not active');
        active = true;
        harness.resume();
        const first = await root.submit(
          {
            type: 'input',
            requestId: 'first-request',
            content: 'First public task',
            whenBusy: 'followUp',
          },
          BG,
        );
        const actual = await Promise.race([
          observed,
          first.wait(BG).then(() => {
            throw new Error('Input settled without native source');
          }),
        ]);
        expect(actual.inputs.map((i) => [i.submissionId, i.requestId])).toEqual(
          [[Number(first.id), 'first-request']],
        );
        expect(actual.toolTaskId).not.toBe(actual.generationTaskId);
        await expect(
          cloudMemberSource(
            storage,
            { conversationId: root.id, taskId: actual.generationTaskId },
            'tool',
            authority,
          ),
        ).rejects.toThrow('actual tool task');
        await expect(
          cloudMemberSource(
            storage,
            {
              conversationId: 1001 as ConversationId,
              taskId: actual.toolTaskId,
            },
            'tool',
            authority,
          ),
        ).rejects.toThrow('CLOUD_MEMBER_SOURCE_SCOPE_CONFLICT');
        const second = await root.submit(
          {
            type: 'input',
            requestId: 'second-request',
            content: 'Only handle the preview environment.',
            whenBusy: mode,
          },
          BG,
        );
        expect(
          (
            await cloudMemberSource(
              storage,
              { conversationId: root.id, taskId: actual.toolTaskId },
              'tool',
              authority,
            )
          ).inputs,
        ).toEqual(actual.inputs);
        allowed = false;
        await expect(
          cloudMemberSource(
            storage,
            { conversationId: root.id, taskId: actual.toolTaskId },
            'tool',
            authority,
          ),
        ).rejects.toThrow('live ACL denied');
        allowed = true;
        let authorityChecks = 0;
        await expect(
          cloudMemberSource(
            storage,
            { conversationId: root.id, taskId: actual.toolTaskId },
            'tool',
            {
              active: () => active,
              authorize: () => {
                if (++authorityChecks === 2)
                  throw new Error('revoked during source read');
              },
            },
          ),
        ).rejects.toThrow('revoked during source read');
        release();
        const a = await first.wait(BG),
          b = await second.wait(BG);
        expect(a.status).toBe('done');
        expect(b.status).toBe('done');
        expect(sources).toHaveLength(2);
        const expected =
          mode === 'steer'
            ? ['first-request', 'second-request']
            : ['second-request'];
        expect(sources[1].inputs.map((i) => i.requestId)).toEqual(expected);
        expect(sources[1].generationTaskId).not.toBe(actual.generationTaskId);
        await expect(
          cloudMemberSource(
            storage,
            { conversationId: root.id, taskId: actual.toolTaskId },
            'tool',
            authority,
          ),
        ).rejects.toThrow('not active');
        expect(faux.state.callCount).toBe(mode === 'steer' ? 3 : 4);
        expect(generations).toHaveLength(faux.state.callCount);
        expect(generations.at(-1)!.inputs.map((i) => i.requestId)).toEqual(
          expected,
        );
        for (const generation of generations) {
          expect(generation.toolTaskId).toBe(generation.generationTaskId);
          expect(generation.attempt).toBeGreaterThan(0);
        }
        console.info(
          'NATIVE_SOURCE_PROOF ' +
            JSON.stringify({
              runtime: 'workerd-sqlite-native-harness',
              mode,
              model_calls: faux.state.callCount,
              sources,
              generations,
            }),
        );
      } finally {
        active = false;
        allowed = true;
        release();
        await harness.close(BG);
      }
    });
  },
  30000,
);
