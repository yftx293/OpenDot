import { createHash } from 'node:crypto';
import {
  InboxDoc,
  LiveDoc,
  type ConversationView,
  type InboxState,
  type LiveState,
} from '@earendil-works/pi-durable';
import {
  type ProductInput,
  type ProductInputPayload,
} from './product-runtime-store.js';

/** Presentation only. Neither reading this view nor leaving a client schedules work. */
export function projectDurableSession(
  view: ConversationView,
  inputs: ProductInput[],
  plainTextInbox = false,
) {
  const live = (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
  const inbox = (view.docs[InboxDoc.definition.kind] ?? {
    items: [],
  }) as InboxState;
  return {
    busy: !!live.run,
    taskId: live.run?.taskId ?? null,
    partialText: live.run
      ? (live.generation?.message?.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
      : '',
    retrying: !!live.run && !!live.generation?.retry,
    tools: live.run
      ? (live.tools ?? []).map(({ callId, name, status }) => ({
          callId,
          name,
          status,
        }))
      : [],
    queueDigest: createHash('sha256')
      .update(JSON.stringify(inbox.items))
      .digest('hex'),
    queue: inbox.items
      .filter((item) => item.mode !== 'write')
      .map((item) => {
        const input = inputs.find((row) => row.submission_id === item.id);
        const payload =
          input && !plainTextInbox && typeof item.content === 'string'
            ? (JSON.parse(item.content) as ProductInputPayload)
            : null;
        return {
          submissionId: item.id,
          inputId: input?.id ?? null,
          mode: item.mode,
          content:
            plainTextInbox && typeof item.content === 'string'
              ? item.content
              : (payload?.content ?? ''),
          requestId: input?.request_id ?? null,
        };
      }),
  };
}
