import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  GenerationTask,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { expect, test } from 'vitest';
import {
  PiDurableRuntimeAdapter,
  type ProductToolSource,
} from '../src/personal-agent/durable-runtime.js';

test.each(['followUp', 'steer'] as const)(
  'native tool source excludes queued %s input, binds it at the actual boundary, and expires with its generation',
  async (mode) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'tool-source-')),
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    let adapter!: PiDurableRuntimeAdapter;
    let allowed = true;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstSeen!: (source: ProductToolSource) => void;
    let firstFailed!: (error: unknown) => void;
    const firstSource = new Promise<ProductToolSource>((resolve, reject) => {
      firstSeen = resolve;
      firstFailed = reject;
    });
    const sources: ProductToolSource[] = [];
    const generations: Awaited<
      ReturnType<PiDurableRuntimeAdapter['productGenerationSource']>
    >[] = [];
    const tool = defineTool({
      name: 'prove_native_source',
      description:
        'Observe the actual tool generation and its placed native inputs.',
      parameters: Type.Object({ label: Type.String() }),
      replay: 'safe',
      async execute(args, api) {
        let source: ProductToolSource;
        try {
          source = await adapter.productToolSource(
            api.conversationId,
            api.taskId,
          );
        } catch (error) {
          firstFailed(error);
          throw error;
        }
        sources.push(source);
        if (args.label === 'first') {
          firstSeen(source);
          await hold;
        }
        return {
          output: [{ type: 'text' as const, text: 'NATIVE_SOURCE_BOUND' }],
        };
      },
    });
    const extension = defineExtension({
      name: 'tool-source-proof',
      tools: [tool],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, api) => {
            generations.push(
              await adapter.productGenerationSource(
                api.conversationId,
                api.taskId,
              ),
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
    adapter = await PiDurableRuntimeAdapter.open({
      databasePath: path.join(root, 'runtime.sqlite'),
      models,
      registry,
      authorizeConversationCreation: () => undefined,
      authorizeConversation: () => {
        if (!allowed) throw new Error('live ACL denied');
      },
      recordInputRequest: () => undefined,
    });
    try {
      const conversationId = await adapter.initializeProductRoot({
        model: { provider: selected.provider, modelId: selected.id },
        extensions: [extension],
        tools: [tool],
      });
      expect(faux.state.callCount).toBe(0);
      await expect(
        adapter.productToolSource(conversationId, 1),
      ).rejects.toThrow('not active');
      await adapter.activate(() => undefined);
      const first = await adapter.submitInput(
        conversationId,
        'first-request',
        'First public task',
        'followUp',
      );
      const actual = await Promise.race([
        firstSource,
        first.submission.wait(BACKGROUND_CONTEXT).then(() => {
          throw new Error(
            'Input settled without the expected native tool source',
          );
        }),
      ]);
      expect(actual.inputs.map((i) => [i.submissionId, i.requestId])).toEqual([
        [Number(first.id), 'first-request'],
      ]);
      expect(actual.toolTaskId).toBeGreaterThan(0);
      expect(actual.generationTaskId).toBeGreaterThan(0);
      expect(actual.toolTaskId).not.toBe(actual.generationTaskId);
      await expect(
        adapter.productToolSource(conversationId, actual.generationTaskId),
      ).rejects.toThrow('actual tool task');
      const second = await adapter.submitInput(
        conversationId,
        'second-request',
        'Only handle the preview environment.',
        mode,
      );
      expect(
        (await adapter.productToolSource(conversationId, actual.toolTaskId))
          .inputs,
      ).toEqual(actual.inputs);
      await expect(
        adapter.productToolSource(
          (Number(conversationId) + 1000) as ConversationId,
          actual.toolTaskId,
        ),
      ).rejects.toThrow('not active');
      allowed = false;
      await expect(
        adapter.productToolSource(conversationId, actual.toolTaskId),
      ).rejects.toThrow('live ACL denied');
      allowed = true;
      release();
      const a = await first.submission.wait(BACKGROUND_CONTEXT);
      const b = await second.submission.wait(BACKGROUND_CONTEXT);
      expect(a.status).toBe('done');
      expect(b.status).toBe('done');
      expect(sources).toHaveLength(2);
      expect(sources[1].conversationId).toBe(conversationId);
      expect(
        sources[1].inputs.map((i) => [i.submissionId, i.requestId]),
      ).toEqual(
        mode === 'steer'
          ? [
              [Number(first.id), 'first-request'],
              [Number(second.id), 'second-request'],
            ]
          : [[Number(second.id), 'second-request']],
      );
      if (
        a.type === 'input' &&
        a.status === 'done' &&
        b.type === 'input' &&
        b.status === 'done'
      ) {
        if (mode === 'steer') expect(a.answer).toBe(b.answer);
        else expect(a.answer).not.toBe(b.answer);
      }
      expect(sources[1].toolTaskId).not.toBe(actual.toolTaskId);
      expect(sources[1].generationTaskId).not.toBe(actual.generationTaskId);
      await expect(
        adapter.productToolSource(conversationId, actual.toolTaskId),
      ).rejects.toThrow('not active');
      expect(faux.state.callCount).toBe(mode === 'steer' ? 3 : 4);
      expect(generations).toHaveLength(faux.state.callCount);
      expect(generations[0].inputs.map((i) => i.requestId)).toEqual([
        'first-request',
      ]);
      expect(generations.at(-1)!.inputs.map((i) => i.requestId)).toEqual(
        mode === 'steer'
          ? ['first-request', 'second-request']
          : ['second-request'],
      );
      for (const generation of generations) {
        expect(generation.taskId).toBe(generation.generationTaskId);
        expect(generation.attempt).toBeGreaterThan(0);
      }
      console.info(
        'NATIVE_SOURCE_PROOF ' +
          JSON.stringify({
            runtime: 'node-product-pi-adapter',
            mode,
            model_calls: faux.state.callCount,
            sources,
            generations,
          }),
      );
    } finally {
      allowed = true;
      release();
      await adapter.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
