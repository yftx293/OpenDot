import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type ConversationId,
  type SubmissionId,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import {
  isDurableRuntimeEnabled,
  PiDurableRuntimeAdapter,
} from '../src/personal-agent/durable-runtime.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-pi-durable-'));
afterAll(() => fs.rmSync(testRoot, { recursive: true, force: true }));

describe('Pi Durable runtime pilot', () => {
  test('is disabled unless explicitly enabled', () => {
    expect(isDurableRuntimeEnabled(undefined)).toBe(false);
    expect(isDurableRuntimeEnabled('1')).toBe(false);
    expect(isDurableRuntimeEnabled(' TRUE ')).toBe(true);
  });

  test('does not open storage when the runtime flag is off', async () => {
    vi.stubEnv('MINICLAW_DURABLE_RUNTIME', 'false');
    const adapter = await PiDurableRuntimeAdapter.openWhenEnabled({
      databasePath: path.join(testRoot, 'disabled', 'runtime.sqlite'),
      registry: createRegistry(),
      authorizeConversation: () => undefined,
      recordInputRequest: () => undefined,
    });
    expect(adapter).toBeUndefined();
    expect(fs.existsSync(path.join(testRoot, 'disabled'))).toBe(false);
    vi.unstubAllEnvs();
  });

  test('uses a private SQLite file and authorizes before conversation lookup', async () => {
    const databasePath = path.join(testRoot, 'private', 'runtime.sqlite');
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath,
      registry: createRegistry(),
      authorizeConversation: () => {
        throw new Error('denied by MiniClaw ACL');
      },
      recordInputRequest: () => undefined,
    });
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    await expect(
      PiDurableRuntimeAdapter.open({
        databasePath,
        registry: createRegistry(),
        authorizeConversation: () => undefined,
        recordInputRequest: () => undefined,
      }),
    ).rejects.toThrow('already owns this database');
    await expect(
      adapter.submitInput(1 as ConversationId, 'req-1', 'test'),
    ).rejects.toThrow('not active');
    await expect(
      adapter.recoverSubmission(1 as ConversationId, 1 as SubmissionId),
    ).rejects.toThrow('not active');
    await expect(
      adapter.activate(() => {
        throw new Error('owner map invalid');
      }),
    ).rejects.toThrow('owner map invalid');
    await expect(
      adapter.submitInput(1 as ConversationId, 'req-1', 'test'),
    ).rejects.toThrow('not active');
    await adapter.activate(() => undefined);
    await expect(
      adapter.submitInput(1 as ConversationId, 'req-1', 'test'),
    ).rejects.toThrow('denied by MiniClaw ACL');
    await adapter.close();
  });

  test('a committed product binding cannot recreate a missing root checkpoint', async () => {
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath: path.join(testRoot, 'missing-product-root.sqlite'),
      registry: createRegistry(),
      authorizeConversation: () => undefined,
      authorizeConversationCreation: () => undefined,
      recordInputRequest: () => undefined,
    });
    try {
      await expect(
        adapter.initializeProductRoot({}, ROOT_CONVERSATION_ID),
      ).rejects.toThrow('checkpoint is missing');
      await expect(
        adapter.submitInput(ROOT_CONVERSATION_ID, 'must-not-run', 'no replay'),
      ).rejects.toThrow('not active');
    } finally {
      await adapter.close();
    }
  });

  test('product recovery rejects a second conversation before scheduling any tasks', async () => {
    const filename = path.join(testRoot, 'foreign-product-conversation.sqlite');
    const bootstrap = await Harness.open(
      await openNodeSqliteStorage(filename),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const root = await bootstrap.root(BACKGROUND_CONTEXT);
    await bootstrap.createConversation(
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    );
    await bootstrap.close(BACKGROUND_CONTEXT);
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath: filename,
      registry: createRegistry(),
      authorizeConversation: () => undefined,
      authorizeConversationCreation: () => undefined,
      recordInputRequest: () => undefined,
    });
    try {
      await adapter.initializeProductRoot({}, root.id);
      await expect(adapter.productRecoverySubmissions(root.id)).rejects.toThrow(
        'foreign conversation',
      );
      await expect(
        adapter.submitInput(root.id, 'must-not-run', 'no replay'),
      ).rejects.toThrow('not active');
    } finally {
      await adapter.close();
    }
  });

  test('repeated request IDs return the already admitted input', async () => {
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    const first = await conversation.submit(
      { type: 'input', requestId: 'duplicate-input', content: 'continue task' },
      BACKGROUND_CONTEXT,
    );
    const repeated = await conversation.submit(
      { type: 'input', requestId: 'duplicate-input', content: 'continue task' },
      BACKGROUND_CONTEXT,
    );
    expect(repeated.id).toBe(first.id);
    const changedPayload = await conversation.submit(
      {
        type: 'input',
        requestId: 'duplicate-input',
        content: 'different task',
      },
      BACKGROUND_CONTEXT,
    );
    expect(changedPayload.id).toBe(first.id);
    await expect(
      conversation.submit(
        {
          type: 'write',
          requestId: 'duplicate-input',
          entry: { kind: 'note' },
        },
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow('already identifies a submission of type input');
    await harness.close(BACKGROUND_CONTEXT);
  });

  test('host request digest rejection prevents altered duplicate Durable input', async () => {
    const databasePath = path.join(
      testRoot,
      'request-digest',
      'runtime.sqlite',
    );
    const bootstrap = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await bootstrap.root(BACKGROUND_CONTEXT);
    const conversationId = conversation.id;
    await bootstrap.close(BACKGROUND_CONTEXT);

    const digests = new Map<string, string>();
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath,
      registry: createRegistry(),
      authorizeConversation: () => undefined,
      recordInputRequest: (_id, requestId, content) => {
        const digest = crypto
          .createHash('sha256')
          .update(content, 'utf8')
          .digest('hex');
        const previous = digests.get(requestId);
        if (previous && previous !== digest) {
          throw new Error('request ID payload digest mismatch');
        }
        digests.set(requestId, digest);
      },
    });

    try {
      await adapter.activate(() => undefined);
      const first = await adapter.submitInput(
        conversationId,
        'digest-bound-request',
        'continue the authorized task',
      );
      const repeated = await adapter.submitInput(
        conversationId,
        'digest-bound-request',
        'continue the authorized task',
      );
      expect(repeated.id).toBe(first.id);
      await expect(
        adapter.submitInput(
          conversationId,
          'digest-bound-request',
          'replace the task with an altered request',
        ),
      ).rejects.toThrow('payload digest mismatch');
      const snapshot = (await adapter.snapshot(conversationId)) as {
        entries: Array<{ kind: string }>;
      };
      expect(
        snapshot.entries.filter((entry) => entry.kind === 'pi.user'),
      ).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });

  test('authorized conversation watch starts from a snapshot and emits later committed views', async () => {
    const databasePath = path.join(
      testRoot,
      'conversation-watch',
      'runtime.sqlite',
    );
    const bootstrap = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversationId = (await bootstrap.root(BACKGROUND_CONTEXT)).id;
    await bootstrap.close(BACKGROUND_CONTEXT);

    let allowed = true;
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath,
      registry: createRegistry(),
      authorizeConversation: (_id, operation) => {
        if (!allowed && operation === 'read') {
          throw new Error('read access revoked');
        }
      },
      recordInputRequest: () => undefined,
    });
    let receiveUpdate!: () => void;
    const updateReceived = new Promise<void>((resolve) => {
      receiveUpdate = resolve;
    });
    let watch:
      | Awaited<ReturnType<PiDurableRuntimeAdapter['watchConversation']>>
      | undefined;

    try {
      await adapter.activate(() => undefined);
      watch = await adapter.watchConversation(conversationId);
      expect(watch.value.conversation.id).toBe(conversationId);
      watch.start(async (value) => {
        if (value.entries.some((entry) => entry.kind === 'pi.user')) {
          receiveUpdate();
        }
      });
      await adapter.submitInput(
        conversationId,
        'watch-input',
        'a durable watched input',
      );
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          updateReceived,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('watch update timed out')),
              2_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      allowed = false;
      await adapter.submitInput(
        conversationId,
        'watch-input-2',
        'a second durable watched input',
      );
      await expect(watch.closed).resolves.toMatchObject({
        reason: 'listener_error',
      });
    } finally {
      if (watch) await watch.stop();
      await adapter.close();
    }
  });

  test('SQLite checkpoint resumes after Harness close without repeating a memoized effect', async () => {
    const databasePath = path.join(testRoot, 'restart.sqlite');
    const effects: number[] = [];
    let interruptedOnce = false;
    let reachedInterruptedCheckpoint!: () => void;
    const interruptedCheckpoint = new Promise<void>((resolve) => {
      reachedInterruptedCheckpoint = resolve;
    });

    const Work = defineTask<
      { through: number },
      { phase: 'step'; number: number },
      number
    >({
      name: 'miniclaw.test.checkpoint-work',
      version: 1,
      initial: () => ({ phase: 'step', number: 1 }),
      phases: {
        step: async (task, runtime, context) => {
          const number = task.state.checkpoint.number;
          const effectKey = `effect:${number}`;
          if ((await runtime.memo(effectKey, context)) === undefined) {
            await runtime.memo(effectKey, true, context);
            effects.push(number);
          }
          if (number === 2 && !interruptedOnce) {
            interruptedOnce = true;
            reachedInterruptedCheckpoint();
            // Harness.close cancels this wait. The memo is committed, while
            // the next task checkpoint is deliberately not yet committed.
            await runtime.sleep(Date.now() + 60_000, context);
          }
          await runtime.commit(
            () =>
              number >= task.input.through
                ? {
                    status: 'terminal',
                    outcome: { status: 'completed', result: number },
                  }
                : {
                    status: 'running',
                    checkpoint: { phase: 'step', number: number + 1 },
                  },
            context,
          );
        },
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
          context,
        );
      },
    });

    const registry = createRegistry();
    registry.install(
      defineExtension({ name: 'miniclaw-pilot', tasks: [Work] }),
    );
    const open = async () =>
      Harness.open(
        await openNodeSqliteStorage(databasePath),
        { models: createModels(), registry },
        BACKGROUND_CONTEXT,
      );

    const first = await open();
    const taskId = await (
      await first.root(BACKGROUND_CONTEXT)
    ).commit(
      (tx) =>
        tx.createTask(
          Work,
          { through: 3 },
          { ownership: { kind: 'conversation' } },
        ),
      BACKGROUND_CONTEXT,
    );
    first.resume();
    await interruptedCheckpoint;
    await first.close(BACKGROUND_CONTEXT);

    const recovered = await open();
    const result = await recovered.waitForTask(taskId, BACKGROUND_CONTEXT);
    expect(result.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'completed', result: 3 },
    });
    expect(effects).toEqual([1, 2, 3]);
    await recovered.close(BACKGROUND_CONTEXT);
  });
});
