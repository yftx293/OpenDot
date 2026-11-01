import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import {
  AssistantEntry,
  createRegistry,
  Harness,
  type ModelRef,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

/** A no-tools Harness request; callers must never log raw provider exceptions. */
export async function runDurableModelSmoke(options: {
  models: Models;
  model: ModelRef;
  databasePath: string;
  expected: string;
  timeoutMs?: number;
}) {
  const startedAt = Date.now();
  const harness = await Harness.open(
    await openNodeSqliteStorage(options.databasePath),
    { models: options.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  let timeout: NodeJS.Timeout | undefined;
  try {
    fs.chmodSync(options.databasePath, 0o600);
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: options.model },
    });
    const submission = await conversation.submit(
      {
        type: 'input',
        requestId: `real-model-smoke-${randomUUID()}`,
        content: `Reply with exactly this one line: ${options.expected}`,
      },
      BACKGROUND_CONTEXT,
    );
    const settled = await Promise.race([
      submission.wait(BACKGROUND_CONTEXT),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('model request timed out')),
          options.timeoutMs ?? 90_000,
        );
      }),
    ]);
    let answer = '';
    if (settled.status === 'done' && settled.type === 'input') {
      const entry = await conversation.commit(
        (tx) => tx.entry(AssistantEntry, settled.answer),
        BACKGROUND_CONTEXT,
      );
      for (const message of entry?.model ?? []) {
        if (message.role !== 'assistant') continue;
        for (const block of message.content) {
          if (block.type === 'text') answer += block.text;
        }
      }
    }
    answer = answer.trim();
    return {
      durableStorage: fs.existsSync(options.databasePath),
      modelConfigured: true,
      requestCompleted: settled.status === 'done',
      exactMatch: answer === options.expected,
      responseLength: answer.length,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    await harness.close(BACKGROUND_CONTEXT);
  }
}
