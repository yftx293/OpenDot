import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseSync from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Mem0PrivateClient } from '../src/mem0-private-client.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-product-ledger-'));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
const db = await import('../src/db.js');
const product = await import('../src/personal-agent/product-runtime-store.js');
const config = await import('../src/mem0-private-config.js');
const capture = await import('../src/mem0-private-capture.js');
const authority = await import('../src/mem0-private-authority.js');

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'owner',
    username: 'owner',
    password_hash: 'fixture',
    display_name: 'Owner',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup('web:owner', {
    name: 'Private',
    folder: 'owner',
    created_by: 'owner',
    executionMode: 'host',
    added_at: now,
  });
  const profile = db.getOrCreateDefaultAgentProfile('owner');
  db.assignWorkspaceAgentProfile('owner', profile.id);
  config.setMem0OwnerCredential('owner', 'fixture-key');
  config.setMem0DotPolicy('owner', profile.id, {
    enabled: true,
    recallEnabled: false,
    captureEnabled: true,
  });
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

it('arms in actual admission and cannot add until Product Input and answer binding commit', async () => {
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  db.createAgent(
    {
      id: sessionId,
      chat_jid: 'web:owner',
      group_folder: 'owner',
      name: 'Private Dot',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
      source_kind: 'manual',
    },
    { kind: 'pi-durable', providerId: 'fixture', configFingerprint: 'frozen' },
  );
  product.bindProductConversation(sessionId, 1);
  db.ensureChatExists(`web:owner#agent:${sessionId}`);
  const input = product.admitProductInput(
    sessionId,
    'mem0-ledger-request',
    {
      content: 'I like tea',
      followUpBehavior: 'queue',
      sender: 'owner',
      senderName: 'Owner',
    },
    (row) => capture.armMem0PrivateCapture(row.id, 'owner'),
  );
  const inspect = new DatabaseSync(path.join(root, 'db/messages.db'));
  try {
    expect(
      authority.privateMem0ProductInput(inspect, {
        inputId: input.id,
        ownerUserId: 'owner',
        installationId: 'test',
        environment: 'test',
        purpose: 'recall',
      }),
    ).not.toBeNull();
  } finally {
    inspect.close();
  }
  expect(capture.recoverMem0PrivateCaptureSession(sessionId)).toEqual([
    { input_id: input.id, state: 'awaiting_answer' },
  ]);
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ event_id: 'event-1', status: 'PENDING' }),
    );
  const client = (key: string) => new Mem0PrivateClient(key, send);
  product.markProductInputSubmitted(input.id, 1);
  capture.finalizeMem0PrivateCapture(input.id, 'owner', 'I like tea', 'Noted.');
  await capture.dispatchMem0PrivateCapture(input.id, client);
  expect(send).not.toHaveBeenCalled();
  product.finishProductInput(input.id, true, (timestamp) => {
    const answer = product.bindProductAnswer(input, 7);
    expect(answer).not.toBeNull();
    db.storeMessageDirect(
      answer!.messageId,
      `web:owner#agent:${sessionId}`,
      'pi-durable',
      'MiniClaw',
      'Noted.',
      timestamp,
      true,
    );
  });
  expect(
    product.listProductInputs(sessionId).find((row) => row.id === input.id)
      ?.state,
  ).toBe('completed');
  expect(product.productAnswerEntryId(input.id)).toBe(7);
  const afterAnswer = new DatabaseSync(path.join(root, 'db/messages.db'));
  try {
    expect(
      authority.privateMem0ProductInput(afterAnswer, {
        inputId: input.id,
        ownerUserId: 'owner',
        installationId: 'test',
        environment: 'test',
        purpose: 'capture',
      }),
    ).not.toBeNull();
  } finally {
    afterAnswer.close();
  }
  capture.finalizeMem0PrivateCapture(input.id, 'owner', 'I like tea', 'Noted.');
  await capture.dispatchMem0PrivateCapture(input.id, client);
  expect(send).toHaveBeenCalledTimes(1);
  const raw = new DatabaseSync(path.join(root, 'db/messages.db'));
  try {
    const row = raw
      .prepare(
        'SELECT state,event_id,ciphertext FROM mem0_private_capture_intents WHERE input_id=?',
      )
      .get(input.id);
    expect(row).toMatchObject({
      state: 'accepted',
      event_id: 'event-1',
      ciphertext: null,
    });
  } finally {
    raw.close();
  }
});
