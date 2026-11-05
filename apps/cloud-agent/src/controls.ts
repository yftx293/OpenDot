import { z } from 'zod';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  ROOT_CONVERSATION_ID,
  type Cursor,
  type Harness,
  type TaskId,
  type ConversationView,
} from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import {
  defineDocFamily,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import {
  applyQueueControlCore,
  parseQueueCommand,
  initialQueueReceipt,
  QUEUE_RECEIPT_KIND,
  type MutableQueueInbox,
  type PreparedQueueCommand,
} from '../../../src/personal-agent/queue-control-core.js';
const QueueCommandSchema = z.unknown().transform((input, context) => {
  try {
    return parseQueueCommand(input);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid queue command' });
    return z.NEVER;
  }
});
const Receipt = defineDocFamily<
  { digest: string; settled: boolean; applied: boolean },
  string
>({
  kind: QUEUE_RECEIPT_KIND,
  version: 1,
  family: true,
  scope: 'session',
  initial: initialQueueReceipt,
});
async function applyQueueControl(
  conversation: Conversation,
  id: string,
  hash: string,
  prepared: PreparedQueueCommand,
  authorize: (mutating: boolean) => boolean | void,
  mustExist: boolean,
) {
  return conversation.commit(async (tx) => {
    const receipt = await tx.doc(Receipt, `${conversation.id}:${id}`, hash);
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const records = await Promise.all(
      prepared.targets.map((target) =>
        tx.submissionByRequest(conversation.id, target.requestId),
      ),
    );
    const task =
      prepared.command.action === 'abort'
        ? await tx.task(prepared.command.taskId as TaskId)
        : null;
    const live =
      prepared.command.action === 'abort'
        ? await tx.doc(LiveDoc, conversation.id)
        : null;
    return applyQueueControlCore(
      {
        conversationId: conversation.id,
        receipt,
        inbox: inbox as unknown as MutableQueueInbox,
        records,
        task,
        live,
        digestItems: (items) => digest(JSON.stringify(items)),
        settle: (submission) =>
          tx.settleSubmission(submission as SubmissionId, {
            status: 'unanswered',
            reason: 'aborted',
          }),
      },
      hash,
      prepared,
      authorize,
      mustExist,
    );
  }, BG);
}
import { CloudError, digest, InputSchema, type CloudInput } from './protocol';
export const ControlSchema = z
  .object({
    id: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    payload: z.string().max(65536),
  })
  .strict();
export type CloudControl = z.infer<typeof ControlSchema> & {
  state: 'pending' | 'applied' | 'rejected';
};
const Prepared = z
  .object({
    command: QueueCommandSchema,
    targets: z
      .array(
        z
          .object({
            submissionId: z.number().int().positive(),
            requestId: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(100),
    payload: z.string().max(65536).optional(),
    goalRunId: z.uuid().optional(),
  })
  .strict();
async function receipt(storage: SqliteStorage, id: string) {
  const record = await storage.findDocument(
    {
      kind: 'miniclaw.queue-control',
      scope: { kind: 'session' },
      key: `${ROOT_CONVERSATION_ID}:${id}`,
    },
    'current',
    BG,
  );
  const doc = record && (await storage.document(record.id, 'current', BG));
  return doc
    ? z
        .object({
          digest: z.string(),
          settled: z.boolean(),
          applied: z.boolean(),
        })
        .strict()
        .parse(doc.value)
    : null;
}
export async function validateCloudControls(
  harness: Harness | null,
  storage: SqliteStorage,
  controls: CloudControl[],
  authorize: (control: CloudControl, historical: boolean) => Promise<void>,
  acknowledge: (id: string, applied: boolean) => void,
  readOnly = false,
) {
  const known = new Set(
    controls.map((row) => `${ROOT_CONVERSATION_ID}:${row.id}`),
  );
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanDocuments(
      {
        scope: { kind: 'session' },
        kind: 'miniclaw.queue-control',
        at: 'current',
      },
      100,
      cursor,
      BG,
    );
    if (page.items.some((row) => !row.key || !known.has(row.key)))
      throw new CloudError(409, 'CLOUD_CONTROL_CHECKPOINT_ORPHAN');
    cursor = page.next;
  } while (cursor !== undefined);
  // Verify every control before applying any admission gap. None of these
  // operations calls resume(), submit(), wait() or Conversation.abort().
  for (const row of controls) {
    ControlSchema.parse({
      id: row.id,
      digest: row.digest,
      payload: row.payload,
    });
    if ((await digest(row.payload)) !== row.digest)
      throw new CloudError(409, 'CLOUD_CONTROL_CORRUPT');
    Prepared.parse(JSON.parse(row.payload));
    const native = await receipt(storage, row.id);
    if (
      (native && native.digest !== row.digest) ||
      (row.state !== 'pending' &&
        (!native?.settled || native.applied !== (row.state === 'applied')))
    )
      throw new CloudError(409, 'CLOUD_CONTROL_CHECKPOINT_MISSING');
    await authorize(row, readOnly || native?.settled === true);
  }
  if (readOnly) return;
  const conversation = await harness!.conversation(ROOT_CONVERSATION_ID, BG);
  if (!conversation) throw new CloudError(404, 'CLOUD_SESSION_NOT_FOUND');
  for (const row of controls) {
    const prepared = Prepared.parse(JSON.parse(row.payload));
    const result = await applyQueueControl(
      conversation,
      row.id,
      row.digest,
      {
        ...prepared,
        ...(prepared.command.action === 'edit'
          ? { payload: prepared.command.content }
          : {}),
      },
      () => {},
      row.state !== 'pending',
    );
    if (result.applied && prepared.command.action === 'abort') {
      const task = await harness!.getTask(
        prepared.command.taskId as TaskId,
        BG,
      );
      if (
        !task ||
        task.conversationId !== ROOT_CONVERSATION_ID ||
        (row.state !== 'pending' &&
          !task.abortRequested &&
          task.state.status !== 'terminal')
      )
        throw new CloudError(409, 'CLOUD_ABORT_CHECKPOINT_MISSING');
      // In pinned Pi 1.3.0 TaskScheduler.abort commits the mark without resume.
      await harness!.abortTask(task.id, BG);
    }
    acknowledge(row.id, result.applied);
  }
}

/** Check the actual queued bytes/mode, not just a parallel admission digest. */
export async function validateCloudInbox(
  view: ConversationView,
  storage: SqliteStorage,
  inputs: { payload: string }[],
  controls: CloudControl[],
) {
  const expected = new Map<number, CloudInput>();
  for (const row of inputs) {
    const input = InputSchema.parse(JSON.parse(row.payload));
    const native = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      input.request_id,
      BG,
    );
    if (native) expected.set(Number(native.id), { ...input });
  }
  for (const row of controls) {
    const native = await receipt(storage, row.id);
    if (!native?.settled || !native.applied) continue;
    const prepared = Prepared.parse(JSON.parse(row.payload)),
      command = prepared.command;
    if (command.action === 'edit' || command.action === 'steer') {
      const input = expected.get(command.submissionId);
      if (!input) throw new CloudError(409, 'CLOUD_CONTROL_TARGET_MISSING');
      if (command.action === 'edit') input.content = command.content;
      else input.when_busy = 'steer';
    }
  }
  const inbox = z
    .object({
      items: z.array(
        z
          .object({ id: z.number(), mode: z.string(), content: z.unknown() })
          .passthrough(),
      ),
    })
    .parse(view.docs['pi.inbox'] ?? { items: [] });
  for (const item of inbox.items) {
    if (item.mode === 'write') continue;
    const input = expected.get(item.id);
    if (
      !input ||
      item.content !== input.content ||
      item.mode !== input.when_busy
    )
      throw new CloudError(409, 'CLOUD_INBOX_BINDING_CONFLICT');
  }
}
