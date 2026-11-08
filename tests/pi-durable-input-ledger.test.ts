import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { PiDurableRuntimeAdapter } from '../src/personal-agent/durable-runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-input-ledger-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function bootstrap(name: string, legacyInput = false) {
  const databasePath = path.join(root, `${name}.sqlite`);
  const harness = await Harness.open(
    await openNodeSqliteStorage(databasePath),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT);
    if (legacyInput) {
      await conversation.submit(
        { type: 'input', requestId: 'legacy-request', content: 'old input' },
        BACKGROUND_CONTEXT,
      );
    }
    return { databasePath, conversationId: conversation.id };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

async function open(databasePath: string) {
  const adapter = await PiDurableRuntimeAdapter.open({
    databasePath,
    registry: createRegistry(),
    authorizeConversation: () => undefined,
    // The adapter's SQLite guard must work even if a host hook does nothing.
    recordInputRequest: () => undefined,
  });
  await adapter.activate(() => undefined);
  return adapter;
}

describe('Persistent Durable input payload bindings', () => {
  test('same input returns the same receipt after reopen; changed content fails closed', async () => {
    const { databasePath, conversationId } = await bootstrap('restart');
    const first = await open(databasePath);
    let receipt;
    try {
      receipt = await first.submitInput(
        conversationId,
        'stable-request',
        'authorized input',
      );
    } finally {
      await first.close();
    }
    const reopened = await open(databasePath);
    try {
      const repeated = await reopened.submitInput(
        conversationId,
        'stable-request',
        'authorized input',
      );
      expect(repeated.id).toBe(receipt.id);
      await expect(
        reopened.submitInput(conversationId, 'stable-request', 'altered input'),
      ).rejects.toMatchObject({ code: 'DURABLE_INPUT_CONFLICT' });
    } finally {
      await reopened.close();
    }
  });

  test('concurrent different payloads under one ID cannot both be admitted', async () => {
    const { databasePath, conversationId } = await bootstrap('race');
    const adapter = await open(databasePath);
    try {
      const results = await Promise.allSettled([
        adapter.submitInput(conversationId, 'racing-request', 'first input'),
        adapter.submitInput(conversationId, 'racing-request', 'second input'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.code).toBe(
        'DURABLE_INPUT_CONFLICT',
      );
    } finally {
      await adapter.close();
    }
  });

  test('does not invent a trusted binding for a legacy unverified submission', async () => {
    const { databasePath, conversationId } = await bootstrap('legacy', true);
    const adapter = await open(databasePath);
    try {
      await expect(
        adapter.submitInput(conversationId, 'legacy-request', 'old input'),
      ).rejects.toThrow('no verified payload binding');
    } finally {
      await adapter.close();
    }
  });

  test('rejects empty or oversized IDs before persisting admission', async () => {
    const { databasePath, conversationId } = await bootstrap('validation');
    const adapter = await open(databasePath);
    try {
      for (const requestId of ['', ' ', 'x'.repeat(257)]) {
        await expect(
          adapter.submitInput(conversationId, requestId, 'input'),
        ).rejects.toThrow('request ID');
      }
    } finally {
      await adapter.close();
    }
  });
});
