import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import {
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Cursor,
} from '@earendil-works/pi-durable';
import type { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { CloudError } from './protocol';
import { readRootView } from './read-view';

/** Storage-only handoff proof. Never open another Harness to inspect an owner:
 * even a paused Harness reconciles running tasks. Pending work must finish under
 * its original owner, not be stopped and then adopted by a newer occurrence. */
export async function assertExecutionQuiescent(
  storage: SqliteStorage,
  initial: boolean,
) {
  let cursor: Cursor | undefined;
  let conversations = 0;
  do {
    const page = await storage.scanConversations({}, 100, cursor, BG);
    for (const row of page.items) {
      if (row.id !== ROOT_CONVERSATION_ID || row.parent || row.owner)
        throw new CloudError(409, 'CLOUD_CONVERSATION_SCOPE_CONFLICT');
      conversations++;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  if (!conversations && !initial)
    throw new CloudError(409, 'CLOUD_EXECUTION_CHECKPOINT_MISSING');
  let scanned = 0;
  do {
    const page = await storage.scanTasks({}, 100, cursor, BG);
    for (const task of page.items) {
      if (++scanned > 10000) throw new CloudError(409, 'CLOUD_TASK_LIMIT');
      if (!conversations || task.conversationId !== ROOT_CONVERSATION_ID)
        throw new CloudError(409, 'CLOUD_TASK_SCOPE_CONFLICT');
      if (task.state.status !== 'terminal')
        throw new CloudError(409, 'CLOUD_PREVIOUS_EXECUTION_PENDING');
    }
    cursor = page.next;
  } while (cursor !== undefined);
  do {
    const page = await storage.scanSubmissions({}, 100, cursor, BG);
    for (const submission of page.items) {
      if (
        !conversations ||
        submission.conversationId !== ROOT_CONVERSATION_ID ||
        submission.type !== 'input'
      )
        throw new CloudError(409, 'CLOUD_UNTRUSTED_CHECKPOINT');
      if (!['done', 'unanswered'].includes(submission.status))
        throw new CloudError(409, 'CLOUD_PREVIOUS_EXECUTION_PENDING');
    }
    cursor = page.next;
  } while (cursor !== undefined);
  if (conversations) {
    const view = await readRootView(storage);
    const live = view.docs[LiveDoc.definition.kind];
    const inbox = view.docs[InboxDoc.definition.kind];
    if (
      live?.run !== undefined ||
      (inbox && (!Array.isArray(inbox.items) || inbox.items.length))
    )
      throw new CloudError(409, 'CLOUD_PREVIOUS_EXECUTION_PENDING');
  }
}
