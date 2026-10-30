import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  defineDocFamily,
  InboxDoc,
  LiveDoc,
  type TaskId,
  type SubmissionId,
  type Conversation,
} from '@earendil-works/pi-durable';

import {
  applyQueueControlCore,
  QUEUE_RECEIPT_KIND,
  initialQueueReceipt,
  type MutableQueueInbox,
} from './queue-control-core.js';

const base = { expectedQueueDigest: z.string().regex(/^[a-f0-9]{64}$/) };
const target = { submissionId: z.number().int().positive() };
export const QueueCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      ...target,
      action: z.literal('edit'),
      content: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z.object({ ...base, ...target, action: z.literal('cancel') }).strict(),
  z.object({ ...base, ...target, action: z.literal('steer') }).strict(),
  z
    .object({
      ...base,
      action: z.literal('abort'),
      taskId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('reorder'),
      submissionIds: z.array(z.number().int().positive()).max(500),
    })
    .strict(),
]);
export type QueueCommand = z.infer<typeof QueueCommandSchema>;
export type PreparedQueueCommand = {
  command: QueueCommand;
  targets: { submissionId: number; requestId: string }[];
  payload?: string;
  goalRunId?: string;
};
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
export const queueDigest = (items: unknown) =>
  createHash('sha256').update(JSON.stringify(items)).digest('hex');

/** Receipt and Inbox mutation share one official Harness commit. No task resumes here. */
export async function applyQueueControl(
  conversation: Conversation,
  id: string,
  digest: string,
  prepared: PreparedQueueCommand,
  authorize: (mutating: boolean) => boolean | void,
  mustExist = false,
) {
  return conversation.commit(async (tx) => {
    const receipt = await tx.doc(Receipt, `${conversation.id}:${id}`, digest);
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const command = prepared.command;
    const records = await Promise.all(
      prepared.targets.map((target) =>
        tx.submissionByRequest(conversation.id, target.requestId),
      ),
    );
    const task =
      command.action === 'abort'
        ? await tx.task(command.taskId as TaskId)
        : null;
    const live =
      command.action === 'abort'
        ? await tx.doc(LiveDoc, conversation.id)
        : null;
    return applyQueueControlCore(
      {
        conversationId: conversation.id,
        receipt,
        // Structural view of the SDK draft. No new item/ID is created by the core.
        inbox: inbox as unknown as MutableQueueInbox,
        records,
        task,
        live,
        digestItems: queueDigest,
        settle: (id) =>
          tx.settleSubmission(id as SubmissionId, {
            status: 'unanswered',
            reason: 'aborted',
          }),
      },
      digest,
      prepared,
      authorize,
      mustExist,
    );
  }, BACKGROUND_CONTEXT);
}
