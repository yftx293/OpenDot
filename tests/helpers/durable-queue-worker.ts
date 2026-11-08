// Real SQLite/Harness receipt-gap fault fixture. No model or product HTTP listener.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness, createRegistry, InboxDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import * as db from '../../src/db.js';
import * as product from '../../src/personal-agent/product-runtime-store.js';
import {
  applyQueueControl,
  queueDigest,
  type PreparedQueueCommand,
} from '../../src/personal-agent/queue-control.js';
db.initDatabase();
const [mode, existingId] = process.argv.slice(2);
const owner = 'queue-process-owner',
  now = new Date().toISOString();
const sessionId = existingId ?? randomUUID();
if (mode === 'crash') {
  db.createUser({
    id: owner,
    username: owner,
    password_hash: 'fixture',
    display_name: owner,
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup('web:queue-process', {
    name: 'queue process',
    folder: 'queue-process',
    created_by: owner,
    executionMode: 'host',
    added_at: now,
    is_home: false,
  });
  db.createAgent(
    {
      id: sessionId,
      chat_jid: 'web:queue-process',
      group_folder: 'queue-process',
      name: 'Queue fixture',
      kind: 'conversation',
      prompt: '',
      status: 'idle',
      created_by: owner,
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    },
    { kind: 'pi-durable', providerId: 'fixture', configFingerprint: 'frozen' },
  );
}
const storage = await openNodeSqliteStorage(
  path.join(process.cwd(), 'data/db/queue-fixture.sqlite'),
);
const harness = await Harness.open(
  storage,
  { registry: createRegistry(), models: createModels() },
  ctx,
);
const conversation = await harness.root(ctx);
product.bindProductConversation(sessionId, conversation.id);
if (mode === 'crash') {
  const input = product.admitProductInput(
    sessionId,
    'original-input',
    {
      content: 'ORIGINAL',
      followUpBehavior: 'queue',
      sender: owner,
      senderName: 'Fixture',
    },
    () => {},
  );
  const submission = await conversation.commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const record = await tx.createSubmission({
      conversationId: conversation.id,
      type: 'input',
      status: 'queued',
      requestId: input.request_id,
    });
    inbox.items.push({
      id: record.id,
      mode: 'followUp',
      content: input.payload,
    });
    return record;
  }, ctx);
  product.markProductInputSubmitted(input.id, submission.id);
  const watch = await conversation.watch(ctx),
    items = (watch.value.docs['pi.inbox'] as { items: unknown[] }).items;
  await watch.stop();
  const prepared: PreparedQueueCommand = {
    command: {
      action: 'edit',
      submissionId: submission.id,
      expectedQueueDigest: queueDigest(items),
      content: 'EDITED_ONCE',
    },
    targets: [{ submissionId: submission.id, requestId: input.request_id }],
    payload: JSON.stringify({
      ...JSON.parse(input.payload),
      content: 'EDITED_ONCE',
    }),
  };
  const intent = product.admitQueueControl(
    sessionId,
    'original-control',
    prepared,
  );
  const result = await applyQueueControl(
    conversation,
    intent.id,
    intent.payload_digest,
    prepared,
    () => {
      product.requireProductRuntime(sessionId, owner);
    },
  );
  if (!result.applied) throw new Error('Fixture edit not applied');
  const latest = await conversation.watch(ctx);
  const currentItems = (latest.value.docs['pi.inbox'] as { items: unknown[] })
    .items;
  await latest.stop();
  const deniedPrepared: PreparedQueueCommand = {
    ...prepared,
    goalRunId: 'expired-goal-run',
    command: {
      action: 'edit',
      submissionId: submission.id,
      expectedQueueDigest: queueDigest(currentItems),
      content: 'MUST_NOT_APPLY',
    },
    payload: JSON.stringify({
      ...JSON.parse(input.payload),
      content: 'MUST_NOT_APPLY',
    }),
  };
  const denied = product.admitQueueControl(
    sessionId,
    'denied-control',
    deniedPrepared,
  );
  const refused = await applyQueueControl(
    conversation,
    denied.id,
    denied.payload_digest,
    deniedPrepared,
    () => false,
  );
  if (refused.applied) throw new Error('Revoked control unexpectedly applied');
  product.finishQueueControl(denied.id, false);

  fs.writeFileSync(
    1,
    JSON.stringify({
      sessionId,
      controlId: intent.id,
      phase: 'native-committed-before-product-receipt',
      conversationId: conversation.id,
      controlIds: product.listQueueControls(sessionId).map((row) => row.id),
    }) + '\n',
  );
  process.kill(process.pid, 'SIGKILL');
} else {
  const intent = product.listQueueControls(sessionId)[0];
  if (intent.state !== 'pending')
    throw new Error('Expected interrupted receipt');
  const watch = await conversation.watch(ctx),
    before = JSON.stringify(watch.value.docs['pi.inbox']);
  await watch.stop();
  const result = await applyQueueControl(
    conversation,
    intent.id,
    intent.payload_digest,
    JSON.parse(intent.payload),
    () => {
      product.requireProductRuntime(sessionId, owner);
    },
  );
  product.finishQueueControl(intent.id, result.applied);
  const after = await conversation.watch(ctx);
  const inbox = after.value.docs['pi.inbox'];
  await after.stop();
  fs.writeFileSync(
    1,
    JSON.stringify({
      sessionId,
      controlId: intent.id,
      state: product.listQueueControls(sessionId)[0].state,
      deniedState: product.listQueueControls(sessionId)[1].state,
      unchanged: before === JSON.stringify(inbox),
      original: JSON.parse(product.listProductInputs(sessionId)[0].payload)
        .content,
      inbox,
    }) + '\n',
  );
  await harness.close(ctx);
  db.closeDatabase();
}
